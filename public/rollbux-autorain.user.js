// ==UserScript==
// @name         Rollbux Rain - Auto Click
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Constantly watches for any button that contains both "Join" and "Rain" and clicks it instantly
// @author       Sotarium
// @match        *://*.rollbux.com/*
// @match        *://rollbux.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    let lastClicked = 0;
    const COOLDOWN_MS = 8000; // prevent spam clicking the same rain

    function findJoinRainButton() {
        const buttons = document.querySelectorAll('button, a, div[role="button"], [class*="button"]');

        for (const btn of buttons) {
            // Skip if it's inside our HUD (if you still have one)
            if (btn.closest('#rollbux-autorain-hud')) continue;

            const text = (btn.innerText || btn.textContent || '').toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

            const combined = text + ' ' + title + ' ' + aria;

            // Must contain both "join" and "rain"
            if (combined.includes('join') && combined.includes('rain')) {
                return btn;
            }
        }
        return null;
    }

    function tryClick() {
        const now = Date.now();
        if (now - lastClicked < COOLDOWN_MS) return;

        const btn = findJoinRainButton();
        if (btn) {
            console.log('[AutoRain] Found Join Rain button → clicking');
            btn.click();
            lastClicked = now;

            // Optional: small visual feedback
            btn.style.outline = '3px solid #00e676';
            setTimeout(() => {
                if (btn) btn.style.outline = '';
            }, 1500);
        }
    }

    // Fast polling (every 400ms)
    setInterval(tryClick, 400);

    // Also watch for DOM changes (more responsive)
    const observer = new MutationObserver(() => {
        tryClick();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('[AutoRain] Watching for any button containing "Join" + "Rain"...');
})();
