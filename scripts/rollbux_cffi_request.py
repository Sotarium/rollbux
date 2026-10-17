#!/usr/bin/env python3
"""
RainRoach - RollBux curl_cffi HTTP Transport Bridge
Executes requests to RollBux impersonating Chrome TLS fingerprint to pass Cloudflare/WAF.
Can be run via CLI with JSON arguments or imported as a module.
"""

import sys
import json
import argparse
from curl_cffi import requests

def make_request(method, url, headers=None, cookies=None, body=None, proxy=None, timeout=20):
    headers = headers or {}
    cookies = cookies or {}
    
    # Ensure standard browser headers
    default_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin"
    }
    for k, v in default_headers.items():
        if k not in headers:
            headers[k] = v

    kwargs = {
        "headers": headers,
        "cookies": cookies,
        "impersonate": "chrome120",
        "timeout": timeout
    }

    if proxy:
        kwargs["proxies"] = {"http": proxy, "https": proxy}

    if body is not None:
        if isinstance(body, (dict, list)):
            kwargs["json"] = body
        else:
            kwargs["data"] = body

    try:
        if method.upper() == "GET":
            r = requests.get(url, **kwargs)
        elif method.upper() == "POST":
            r = requests.post(url, **kwargs)
        elif method.upper() == "PUT":
            r = requests.put(url, **kwargs)
        elif method.upper() == "DELETE":
            r = requests.delete(url, **kwargs)
        else:
            return {"success": False, "error": f"Unsupported method {method}"}

        try:
            json_data = r.json()
        except Exception:
            json_data = None

        return {
            "success": True,
            "status_code": r.status_code,
            "headers": dict(r.headers),
            "cookies": dict(r.cookies),
            "body": r.text,
            "json": json_data
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--stdin":
        input_data = json.loads(sys.stdin.read())
        res = make_request(
            method=input_data.get("method", "GET"),
            url=input_data["url"],
            headers=input_data.get("headers"),
            cookies=input_data.get("cookies"),
            body=input_data.get("body"),
            proxy=input_data.get("proxy"),
            timeout=input_data.get("timeout", 20)
        )
        print(json.dumps(res))
        return

    parser = argparse.ArgumentParser(description="RollBux curl_cffi HTTP bridge")
    parser.add_argument("method", help="GET, POST, etc.")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("--token", help="Bearer session token", default=None)
    parser.add_argument("--body", help="JSON string body", default=None)
    parser.add_argument("--proxy", help="Optional proxy URL", default=None)
    args = parser.parse_args()

    headers = {}
    cookies = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
        cookies["authjs.session-token"] = args.token

    body = json.loads(args.body) if args.body else None

    res = make_request(args.method, args.url, headers=headers, cookies=cookies, body=body, proxy=args.proxy)
    print(json.dumps(res))

if __name__ == "__main__":
    main()
