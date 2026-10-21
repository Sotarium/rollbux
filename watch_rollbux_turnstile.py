r"""Watch a locally running browser for Cloudflare/Turnstile pages on rollbux.com.

Requirements on Windows:
    py -m pip install playwright
    py -m playwright install chromium

The browser must be started with remote debugging enabled, for example:
    chrome.exe --remote-debugging-port=9222

Then run:
    py watch_rollbux_turnstile.py

Screenshots are saved to:
    C:\Users\olivi\Downloads

This script only observes pages whose hostname is exactly rollbux.com.
It does not solve, click, bypass, or submit any challenge.
"""

from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

CDP_URL = "http://127.0.0.1:9222"
SCREENSHOT_DIR = Path(r"C:\Users\olivi\Downloads")
POLL_SECONDS = 1.0

# Text and DOM markers commonly present on Cloudflare/Turnstile interstitials.
CHALLENGE_PATTERNS = [
    re.compile(r"verify you are human", re.I),
    re.compile(r"checking your browser", re.I),
    re.compile(r"just a moment", re.I),
    re.compile(r"turnstile", re.I),
    re.compile(r"cloudflare", re.I),
    re.compile(r"cf-chl-", re.I),
    re.compile(r"challenge-platform", re.I),
]


def is_rollbux_page(page: Page) -> bool:
    """Return True only for the exact rollbux.com hostname."""
    try:
        return (page.url.split("/", 3)[2].split(":", 1)[0].lower() == "rollbux.com")
    except (IndexError, AttributeError):
        return False


def page_fingerprint(page: Page) -> str:
    """Collect challenge-related page signals without interacting with the challenge."""
    try:
        title = page.title()
    except Exception:
        title = ""

    try:
        body_text = page.locator("body").inner_text(timeout=1000)[:20000]
    except Exception:
        body_text = ""

    try:
        iframe_sources = page.locator("iframe").evaluate_all(
            "frames => frames.map(frame => frame.src || '').join(' ')"
        )
    except Exception:
        iframe_sources = ""

    try:
        html_markers = page.locator(
            "[class*='cf-'], [id*='cf-'], [class*='turnstile'], [id*='turnstile']"
        ).count()
    except Exception:
        html_markers = 0

    return "\n".join([title, body_text, iframe_sources, str(html_markers)])


def challenge_detected(page: Page) -> bool:
    if not is_rollbux_page(page):
        return False

    signal = page_fingerprint(page)
    return any(pattern.search(signal) for pattern in CHALLENGE_PATTERNS)


def safe_page_name(page: Page) -> str:
    try:
        path = page.url.split("rollbux.com", 1)[-1]
    except Exception:
        path = "page"
    name = re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")
    return (name or "home")[:70]


def save_challenge_screenshot(page: Page) -> Path | None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output = SCREENSHOT_DIR / f"rollbux_turnstile_{timestamp}_{safe_page_name(page)}.png"
    try:
        page.screenshot(path=str(output), full_page=True)
        return output
    except PlaywrightTimeoutError:
        try:
            page.screenshot(path=str(output), full_page=False)
            return output
        except Exception as exc:
            print(f"[watcher] Screenshot failed: {exc}")
    except Exception as exc:
        print(f"[watcher] Screenshot failed: {exc}")
    return None


def watch_browser(browser: Browser) -> None:
    # Track each page's current challenge state so one challenge does not create
    # hundreds of duplicate screenshots while it remains visible.
    seen_challenge: dict[int, bool] = {}
    last_urls: dict[int, str] = {}

    print("[watcher] Watching exact host: https://rollbux.com")
    print(f"[watcher] Screenshots: {SCREENSHOT_DIR}")
    print("[watcher] Press Ctrl+C to stop.")

    while True:
        pages = list(browser.contexts[0].pages) if browser.contexts else []
        active_ids = set()

        for page in pages:
            page_id = id(page)
            active_ids.add(page_id)
            current_url = page.url
            if current_url != last_urls.get(page_id):
                seen_challenge[page_id] = False
                last_urls[page_id] = current_url

            if not is_rollbux_page(page):
                continue

            detected = challenge_detected(page)
            if detected and not seen_challenge.get(page_id, False):
                screenshot = save_challenge_screenshot(page)
                if screenshot:
                    print(f"[watcher] Challenge detected: {current_url}")
                    print(f"[watcher] Saved: {screenshot}")
                seen_challenge[page_id] = True
            elif not detected:
                seen_challenge[page_id] = False

        for page_id in list(seen_challenge):
            if page_id not in active_ids:
                seen_challenge.pop(page_id, None)
                last_urls.pop(page_id, None)

        time.sleep(POLL_SECONDS)


def main() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.connect_over_cdp(CDP_URL)
        except Exception as exc:
            raise SystemExit(
                "Could not connect to Chrome on port 9222. "
                "Start Chrome with --remote-debugging-port=9222, then run this script.\n"
                f"Details: {exc}"
            ) from exc

        try:
            watch_browser(browser)
        except KeyboardInterrupt:
            print("\n[watcher] Stopped.")
        finally:
            # Do not close the user's browser; only disconnect this watcher.
            browser.close()


if __name__ == "__main__":
    main()
