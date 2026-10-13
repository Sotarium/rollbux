// ==UserScript==
// @name         Rollbux Rain Tracker & Sync
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  Clean HUD: Auto-syncs live balance (bg-neutral-400), rain pot (bg-neutral-500), countdown, profile & transactions to your stats site!
// @author       Sotarium
// @match        *://*.rollbux.com/*
// @match        *://rollbux.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const BACKEND_URL = 'http://127.0.0.1:8765/api/status';
    const FALLBACK_URL = 'http://localhost:3000/api/status';
    const WEBSITE_BASE = 'http://localhost:3000';

    function requestLocal(url, method = 'GET', data = null) {
        return new Promise((resolve, reject) => {
            function tryFetch(targetUrl, isFallback = false) {
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    GM_xmlhttpRequest({
                        method: method,
                        url: targetUrl,
                        data: data ? JSON.stringify(data) : null,
                        headers: { 'Content-Type': 'application/json' },
                        onload: function (resp) {
                            try {
                                resolve(JSON.parse(resp.responseText));
                            } catch (e) {
                                resolve(resp.responseText);
                            }
                        },
                        onerror: function (err) {
                            if (!isFallback && targetUrl !== FALLBACK_URL) {
                                tryFetch(FALLBACK_URL, true);
                            } else {
                                reject(err);
                            }
                        }
                    });
                } else {
                    fetch(targetUrl, {
                        method: method,
                        headers: { 'Content-Type': 'application/json' },
                        body: data ? JSON.stringify(data) : null
                    })
                    .then(r => r.json())
                    .then(resolve)
                    .catch(err => {
                        if (!isFallback && targetUrl !== FALLBACK_URL) {
                            tryFetch(FALLBACK_URL, true);
                        } else {
                            reject(err);
                        }
                    });
                }
            }

            tryFetch(url);
        });
    }

    let currentUsername = localStorage.getItem('rollbux_tracker_username') || sessionStorage.getItem('rollbux_tracker_username') || '';
    let currentAvatarUrl = localStorage.getItem('rollbux_tracker_avatar') || '';
    let totalRainsJoined = parseInt(localStorage.getItem('rollbux_rains_joined') || '0', 10);

    // ==================== ON-SCREEN HUD ====================
    function createOnScreenHUD() {
        if (!document.body) {
            window.addEventListener('DOMContentLoaded', createOnScreenHUD);
            return;
        }
        if (document.getElementById('rollbux-rain-hud')) return;

        const hud = document.createElement('div');
        hud.id = 'rollbux-rain-hud';
        hud.innerHTML = `
            <div id="rain-hud-header" style="display: flex; justify-content: flex-end; align-items: center; padding: 12px 16px 0 16px; cursor: move;">
                <div style="display: flex; gap: 14px; align-items: center;">
                    <svg id="rain-hud-min-btn" width="12" height="12" viewBox="0 0 12 12" style="cursor: pointer; opacity: 0.6; transition: opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">
                        <line x1="1" y1="6" x2="11" y2="6" stroke="#9ca3af" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                    <svg id="rain-hud-close-btn" width="11" height="11" viewBox="0 0 11 11" style="cursor: pointer; opacity: 0.6; transition: opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">
                        <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/>
                        <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                </div>
            </div>
            <div id="rain-hud-body" style="padding: 16px 20px 20px 20px; display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div id="rain-hud-timer" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 34px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 3px; line-height: 1;">
                    --:--
                </div>
                <div style="display: flex; gap: 8px; font-size: 12px; font-weight: 700; margin-bottom: 10px;">
                    <span id="rain-hud-pot" style="color: #acff46;">Pot: --</span>
                    <span style="color: #6d7680;">•</span>
                    <span id="rain-hud-bal" style="color: #ffffff;">Bal: --</span>
                </div>
                
                <div style="background: #ffffff; color: #0a0b0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; font-weight: 700; padding: 10px 16px; border-radius: 12px; width: 100%; box-sizing: border-box; box-shadow: 0 4px 12px rgba(0,0,0,0.25); letter-spacing: 0.2px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <img id="rain-hud-avatar" src="${currentAvatarUrl || 'https://rollbux.com/icons/token.png'}" style="width: 18px; height: 18px; border-radius: 50%; object-fit: cover; display: ${currentAvatarUrl ? 'inline-block' : 'none'};">
                        <span id="rain-hud-user">${currentUsername ? '@' + currentUsername : 'Rains Joined:'}</span>
                    </div>
                    <span id="rain-hud-joined" style="font-weight: 800;">${totalRainsJoined}</span>
                </div>
                
                <!-- Quick Test / Inspect Buttons -->
                <div style="display: flex; gap: 5px; width: 100%; margin-top: 10px;">
                    <button id="rain-hud-get-bal-btn" style="flex: 1; background: rgba(0, 230, 118, 0.15); border: 1px solid #00e676; color: #00e676; font-size: 11px; font-weight: 700; padding: 6px 2px; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                        💳 Balance
                    </button>
                    <button id="rain-hud-get-pot-btn" style="flex: 1; background: rgba(172, 255, 70, 0.15); border: 1px solid #acff46; color: #acff46; font-size: 11px; font-weight: 700; padding: 6px 2px; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                        💰 Pot
                    </button>
                    <button id="rain-hud-get-timer-btn" style="flex: 1; background: rgba(121, 116, 255, 0.15); border: 1px solid #7974ff; color: #7974ff; font-size: 11px; font-weight: 700; padding: 6px 2px; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                        ⏱ Timer
                    </button>
                </div>

                <div style="display: flex; gap: 6px; width: 100%; margin-top: 6px;">
                    <button id="rain-hud-sync-btn" style="flex: 1; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2); color: #ffffff; font-size: 11px; font-weight: 700; padding: 7px 6px; border-radius: 9px; cursor: pointer; transition: all 0.2s;">
                        ⚡ Sync Tx
                    </button>
                    <button id="rain-hud-web-btn" style="flex: 1; background: rgba(172, 255, 70, 0.15); border: 1px solid #acff46; color: #acff46; font-size: 11px; font-weight: 700; padding: 7px 6px; border-radius: 9px; cursor: pointer; transition: all 0.2s;">
                        🌐 My Stats
                    </button>
                </div>
            </div>
        `;

        hud.style.cssText = `
            position: fixed;
            bottom: 35px;
            left: 35px;
            width: 270px;
            background: #111215;
            border-radius: 18px;
            box-shadow: 0 20px 48px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
            z-index: 999999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            user-select: none;
            overflow: hidden;
            transition: height 0.25s ease;
        `;

        document.body.appendChild(hud);

        const closeBtn = document.getElementById('rain-hud-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => hud.style.display = 'none');

        const minBtn = document.getElementById('rain-hud-min-btn');
        const bodyEl = document.getElementById('rain-hud-body');
        if (minBtn && bodyEl) {
            let minimized = false;
            minBtn.addEventListener('click', () => {
                minimized = !minimized;
                bodyEl.style.display = minimized ? 'none' : 'flex';
                hud.style.paddingBottom = minimized ? '12px' : '0';
            });
        }

        // 💳 Get Balance button
        const getBalBtn = document.getElementById('rain-hud-get-bal-btn');
        if (getBalBtn) {
            getBalBtn.addEventListener('click', () => {
                const bal = queryLiveBalance();
                if (bal !== null) {
                    updateHUDBalance(bal);
                    syncRainTick(queryRainPot(), querySiteTimer(), bal);
                    console.log(`%c[Rain HUD] Balance detected: ${bal} BUX`, 'color: #00e676; font-weight: bold;');
                } else {
                    console.warn('[Rain HUD] Balance not detected.');
                }
            });
        }

        // 💰 Get Rain Pot button
        const getPotBtn = document.getElementById('rain-hud-get-pot-btn');
        if (getPotBtn) {
            getPotBtn.addEventListener('click', () => {
                const pot = queryRainPot();
                if (pot > 0) {
                    updateHUDPot(pot);
                    syncRainTick(pot, querySiteTimer(), queryLiveBalance());
                    console.log(`%c[Rain HUD] Pot detected: ${pot} BUX`, 'color: #acff46; font-weight: bold;');
                } else {
                    console.warn('[Rain HUD] Pot not detected.');
                }
            });
        }

        // ⏱ Get Time Left button
        const getTimeBtn = document.getElementById('rain-hud-get-timer-btn');
        if (getTimeBtn) {
            getTimeBtn.addEventListener('click', () => {
                const sec = querySiteTimer();
                if (sec >= 0) {
                    const mins = Math.floor(sec / 60);
                    const s = sec % 60;
                    const str = `${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    updateHUDTimer(str);
                    syncRainTick(queryRainPot(), sec, queryLiveBalance());
                    console.log(`%c[Rain HUD] Timer detected: ${str} (${sec}s)`, 'color: #7974ff; font-weight: bold;');
                } else {
                    console.warn('[Rain HUD] Timer not detected.');
                }
            });
        }

        const syncBtn = document.getElementById('rain-hud-sync-btn');
        if (syncBtn) {
            syncBtn.addEventListener('click', () => {
                sessionStorage.setItem('rollbux_return_to_main', 'true');
                updateHUDTimer('SYNCING...');
                window.location.href = 'https://rollbux.com/profile/transactions';
            });
        }

        const webBtn = document.getElementById('rain-hud-web-btn');
        if (webBtn) {
            webBtn.addEventListener('click', () => {
                const userParam = currentUsername || 'Sotarium';
                const userUrl = `${WEBSITE_BASE}/user/${encodeURIComponent(userParam)}`;
                window.open(userUrl, '_blank');
            });
        }

        let isDragging = false, startX, startY, origX, origY;
        const header = document.getElementById('rain-hud-header');
        if (header) {
            header.addEventListener('mousedown', (e) => {
                if (e.target.closest('svg') || e.target.closest('button')) return;
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = hud.getBoundingClientRect();
                origX = rect.left;
                origY = rect.top;
                hud.style.right = 'auto';
                hud.style.bottom = 'auto';
                hud.style.left = origX + 'px';
                hud.style.top = origY + 'px';
            });
        }

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            hud.style.left = (origX + e.clientX - startX) + 'px';
            hud.style.top = (origY + e.clientY - startY) + 'px';
        });

        window.addEventListener('mouseup', () => { isDragging = false; });
    }

    function updateHUDTimer(text) {
        const timerEl = document.getElementById('rain-hud-timer');
        if (timerEl && text) timerEl.textContent = text;
    }

    function updateHUDPot(amount) {
        const potEl = document.getElementById('rain-hud-pot');
        if (potEl && typeof amount === 'number') {
            potEl.textContent = `Pot: ${amount.toLocaleString()}`;
        }
    }

    function updateHUDBalance(amount) {
        const balEl = document.getElementById('rain-hud-bal');
        if (balEl && typeof amount === 'number') {
            balEl.textContent = `Bal: ${amount.toLocaleString()}`;
        }
    }

    function updateHUDUser(name, avatar) {
        const userEl = document.getElementById('rain-hud-user');
        if (userEl && name) userEl.textContent = '@' + name;
        const avatarEl = document.getElementById('rain-hud-avatar');
        if (avatarEl && avatar) {
            avatarEl.src = avatar;
            avatarEl.style.display = 'inline-block';
        }
    }

    function updateHUDJoined() {
        const joinedEl = document.getElementById('rain-hud-joined');
        if (joinedEl) joinedEl.textContent = totalRainsJoined;
    }

    // ==================== NUMBER-FLOW PARSER ====================
    function parseFlowNumber(flow) {
        if (!flow) return null;
        if (typeof flow.value === 'number') return flow.value;
        if (flow.getAttribute('value')) {
            const v = parseFloat(flow.getAttribute('value'));
            if (!isNaN(v)) return v;
        }

        if (flow.shadowRoot) {
            // 1. Reconstruct using full section structure (integer + fraction)
            const integerSec = flow.shadowRoot.querySelector('[part*="integer"]');
            const fractionSec = flow.shadowRoot.querySelector('[part*="fraction"]');

            function extractSectionDigits(sec) {
                if (!sec) return '';
                let result = '';
                // Check all child elements in order
                const children = Array.from(sec.children);
                for (const child of children) {
                    if (child.classList.contains('symbol')) {
                        const symVal = child.querySelector('.symbol__value') || child;
                        const t = symVal.textContent.trim();
                        if (t === ',' || t === '.') result += t;
                    } else if (child.classList.contains('digit')) {
                        // Priority 1: non-inert digit_num
                        const nonInert = child.querySelector('.digit__num:not([inert])');
                        if (nonInert) {
                            result += nonInert.textContent.trim();
                        } else {
                            // Priority 2: --current style attribute
                            const styleStr = child.getAttribute('style') || '';
                            const m = styleStr.match(/--current:\s*(\d+)/);
                            if (m) {
                                result += m[1];
                            } else {
                                const anyNum = child.querySelector('.digit__num');
                                if (anyNum) result += anyNum.textContent.trim();
                            }
                        }
                    }
                }
                return result;
            }

            let intStr = extractSectionDigits(integerSec);
            let fracStr = extractSectionDigits(fractionSec);

            if (intStr) {
                let fullStr = intStr.replace(/,/g, '');
                if (fracStr) {
                    fracStr = fracStr.replace(/^[^\d]*/, '');
                    fullStr += '.' + fracStr;
                }
                const parsed = parseFloat(fullStr);
                if (!isNaN(parsed)) return parsed;
            }

            // Fallback: Read non-inert digits and symbol values across shadow root
            const activeElements = Array.from(flow.shadowRoot.querySelectorAll('.digit__num:not([inert]), .symbol__value'));
            if (activeElements.length > 0) {
                const str = activeElements.map(e => e.textContent.trim()).join('').replace(/,/g, '');
                const val = parseFloat(str);
                if (!isNaN(val)) return val;
            }
        }

        const text = (flow.innerText || flow.textContent || '').replace(/,/g, '').trim();
        const m = text.match(/[\d.]+/);
        if (m) {
            const val = parseFloat(m[0]);
            if (!isNaN(val)) return val;
        }
        return null;
    }

    function parseNumberFromElement(el) {
        if (!el) return null;
        const nf = el.querySelector('number-flow-react') || (el.tagName.toLowerCase() === 'number-flow-react' ? el : null);
        if (nf) {
            const v = parseFlowNumber(nf);
            if (v !== null) return v;
        }
        const text = (el.innerText || el.textContent || '').replace(/,/g, '').trim();
        const m = text.match(/[\d.]+/);
        if (m) {
            const val = parseFloat(m[0]);
            if (!isNaN(val)) return val;
        }
        return null;
    }

    // ==================== LIVE BALANCE EXTRACTION (bg-neutral-400) ====================
    function queryLiveBalance() {
        try {
            // Target exact balance container: <div class="bg-neutral-400 min-w-25 h-10 rounded-md py-2.5 pl-3 pr-5 ...">
            const exactContainers = Array.from(document.querySelectorAll('div.bg-neutral-400, div[class*="bg-neutral-400"], div[class*="min-w-25"]'));
            for (const c of exactContainers) {
                if (c.closest('#rollbux-rain-hud')) continue;
                const flow = c.querySelector('number-flow-react');
                if (flow) {
                    const val = parseFlowNumber(flow);
                    if (val !== null && val >= 0) return val;
                }
                const val = parseNumberFromElement(c);
                if (val !== null && val >= 0) return val;
            }

            // Fallback: look near wallet button or header
            const walletBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
                .find(el => (el.textContent || '').trim().toLowerCase().includes('wallet'));
            if (walletBtn) {
                const prev = walletBtn.previousElementSibling;
                if (prev) {
                    const val = parseNumberFromElement(prev);
                    if (val !== null && val >= 0) return val;
                }
            }
        } catch (e) {}
        return null;
    }

    // ==================== RAIN POT EXTRACTION ====================
    // Strategy: scan ALL number-flow-react elements visible on the page,
    // exclude those inside HUD and balance container, then find any value
    // near a "RAIN" label or token.png icon, falling back to the largest visible value.
    function queryRainPot() {
        try {
            const myBalance = queryLiveBalance() || 0;

            // Approach 1: Find the rain banner and pick number-flow-react inside it
            // Rain banner identified by text "RAIN" or "rain" in its text content
            const allDivs = Array.from(document.querySelectorAll('div, span, section, aside'));
            for (const el of allDivs) {
                if (el.closest('#rollbux-rain-hud')) continue;
                const txt = (el.textContent || '').trim();
                // Rain banner tends to contain "RAIN" and a coin number
                if (!txt.includes('RAIN') && !txt.includes('Rain')) continue;
                // Only look at small containers
                if (txt.length > 500) continue;

                const flows = el.querySelectorAll('number-flow-react');
                for (const flow of flows) {
                    if (flow.closest('#rollbux-rain-hud')) continue;
                    const val = parseFlowNumber(flow);
                    // Must be a non-trivial pot value (>= 10) and not timer (>= 3600 unreasonable)
                    if (val !== null && val >= 10 && val <= 999999) {
                        // Skip values that look like mm:ss pairs (< 60)
                        if (val < 60) continue;
                        // Skip if it's the user's own balance
                        if (Math.abs(val - myBalance) < 0.01) continue;
                        return val;
                    }
                }
            }

            // Approach 2: Scan every number-flow-react on page, collect all candidates
            const allFlows = Array.from(document.querySelectorAll('number-flow-react'));
            const candidates = [];
            for (const flow of allFlows) {
                if (flow.closest('#rollbux-rain-hud')) continue;
                // Skip if inside balance container
                if (flow.closest('div.bg-neutral-400') || flow.closest('[class*="bg-neutral-400"]')) continue;
                const val = parseFlowNumber(flow);
                if (val !== null && val >= 10 && val < 1000000) {
                    // Skip timer-like values (small integers under 60)
                    if (val < 60) continue;
                    if (Math.abs(val - myBalance) < 0.01) continue;
                    // Check proximity to a token image (within 3 ancestor levels)
                    let el = flow;
                    let hasCoin = false;
                    for (let i = 0; i < 5; i++) {
                        el = el.parentElement;
                        if (!el) break;
                        if (el.querySelector('img[src*="token.png"]')) { hasCoin = true; break; }
                    }
                    candidates.push({ val, hasCoin });
                }
            }

            // Prefer candidates with a coin icon, then largest value
            const withCoin = candidates.filter(c => c.hasCoin);
            if (withCoin.length > 0) {
                return Math.max(...withCoin.map(c => c.val));
            }
            if (candidates.length > 0) {
                return Math.max(...candidates.map(c => c.val));
            }
        } catch (e) {}
        return 0;
    }

    // ==================== SITE TIMER EXTRACTION ====================
    function querySiteTimer() {
        try {
            const all = Array.from(document.querySelectorAll('*'));
            for (const el of all) {
                if (el.id === 'rollbux-rain-hud' || el.closest('#rollbux-rain-hud')) continue;
                if (el.children.length > 0) continue;
                const txt = (el.textContent || '').trim();
                const m = txt.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
                if (m) {
                    const h = m[1] ? parseInt(m[1], 10) : 0;
                    const min = parseInt(m[2], 10);
                    const sec = parseInt(m[3], 10);
                    if (min < 60 && sec < 60) {
                        return (h * 3600) + (min * 60) + sec;
                    }
                }
            }

            const containers = document.querySelectorAll('span.tabular-nums, .rain-banner, [class*="tabular-nums"]');
            for (const container of containers) {
                if (container.closest('#rollbux-rain-hud') || container.closest('.bg-neutral-400')) continue;
                const flows = container.querySelectorAll('number-flow-react');
                if (flows.length >= 2) {
                    const min = parseFlowNumber(flows[0]);
                    const sec = parseFlowNumber(flows[1]);
                    if (min !== null && sec !== null && sec < 60) {
                        return (Math.floor(min) * 60) + Math.floor(sec);
                    }
                }
            }
        } catch (e) {}
        return -1;
    }

    let lastTickTime = 0;
    async function syncRainTick(potAmount, secondsLeft, balance) {
        const now = Date.now();
        if (now - lastTickTime < 900) return;
        lastTickTime = now;

        try {
            await requestLocal(BACKEND_URL, 'POST', {
                username: currentUsername || 'Sotarium',
                avatar: currentAvatarUrl,
                action: 'rain_tick',
                pot_amount: potAmount || 0,
                time_left: secondsLeft >= 0 ? secondsLeft : 0,
                balance: balance !== null && balance !== undefined ? balance : undefined
            });
        } catch (e) {}
    }

    // ==================== CHAT & JOIN ACTIONS ====================
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }
    }

    async function sendChatDot(dotIndex) {
        try {
            const input = document.querySelector('input[name="message"][placeholder*="Type message here" i]')
                       || document.querySelector('input[placeholder*="Type message here" i]')
                       || document.querySelector('input[name="message"]')
                       || document.querySelector('input[type="text"][placeholder*="message" i]');

            if (!input) return false;

            const btn = input.closest('form')?.querySelector('button[type="submit"]')
                     || document.querySelector('button[data-size="icon-sm"][type="submit"]')
                     || document.querySelector('button[type="submit"]');

            let waitCooldown = 0;
            while (btn && btn.disabled && waitCooldown < 5000) {
                await new Promise(r => setTimeout(r, 250));
                waitCooldown += 250;
            }

            input.focus();
            setNativeValue(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 80));

            const dotPatterns = ['.', '..', '...'];
            const messageText = dotPatterns[(dotIndex - 1) % dotPatterns.length] || '.';

            setNativeValue(input, messageText);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: messageText, bubbles: true }));

            await new Promise(r => setTimeout(r, 150));

            if (btn && !btn.disabled) {
                btn.click();
            } else {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function clickJoinRain() {
        const btn = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]')).find(b => {
            const t = (b.textContent || '').toLowerCase().trim();
            return t === 'join' || t.includes('join rain') || t.includes('enter rain');
        });
        if (btn) {
            btn.click();
            totalRainsJoined++;
            localStorage.setItem('rollbux_rains_joined', totalRainsJoined.toString());
            updateHUDJoined();

            sessionStorage.setItem('rollbux_pending_payout_check', 'true');

            try {
                requestLocal(BACKEND_URL, 'POST', {
                    username: currentUsername || 'Sotarium',
                    avatar: currentAvatarUrl,
                    action: 'rain_joined',
                    pot_name: 'Rollbux Rain'
                });
            } catch (e) {}

            return true;
        }
        return false;
    }

    function formatNiceDate(rawStr) {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let d = new Date();
        if (rawStr) {
            const parsed = new Date(rawStr);
            if (!isNaN(parsed.getTime())) d = parsed;
        }
        const day = d.getDate();
        const month = months[d.getMonth()];
        const hours = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        return `${day} ${month} ${hours}h${mins}`;
    }

    // ==================== PROFILE SCRAPER ====================
    function scrapeProfile() {
        let username = '';
        let avatar = '';

        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, span, div'));
        for (const el of headings) {
            const txt = (el.textContent || '').trim();
            if (txt && /^[a-zA-Z0-9_-]{3,24}$/.test(txt) && !['profile', 'affiliates', 'betting', 'transactions', 'ignored', 'overview'].includes(txt.toLowerCase())) {
                const parentText = (el.parentElement?.textContent || '').toLowerCase();
                if (parentText.includes('level') || parentText.includes('joined') || parentText.includes('progress')) {
                    username = txt;
                    break;
                }
            }
        }

        if (!avatar) {
            const avatarImg = document.querySelector('img[src*="avatar"], img[src*="discordapp"], img[src*="cdn.rollbux"]');
            if (avatarImg) avatar = avatarImg.src;
        }

        return { username, avatar };
    }

    // ==================== ROUTE HANDLING ====================
    const path = window.location.pathname.toLowerCase();

    // 1. On /profile
    if (path === '/profile' || path === '/profile/') {
        createOnScreenHUD();
        updateHUDTimer('USER...');
        let attempts = 0;
        const profileInterval = setInterval(async () => {
            attempts++;
            const { username, avatar } = scrapeProfile();
            if (username || attempts >= 8) {
                clearInterval(profileInterval);
                if (username) {
                    currentUsername = username;
                    currentAvatarUrl = avatar || currentAvatarUrl;
                    localStorage.setItem('rollbux_tracker_username', username);
                    sessionStorage.setItem('rollbux_tracker_username', username);
                    if (avatar) localStorage.setItem('rollbux_tracker_avatar', avatar);
                    updateHUDUser(username, avatar);
                    updateHUDTimer('SYNCED');

                    try {
                        await requestLocal(BACKEND_URL, 'POST', {
                            username: username,
                            avatar: avatar,
                            action: 'profile_sync'
                        });
                    } catch (e) {}
                }

                const returnTo = sessionStorage.getItem('rollbux_return_to_main');
                const nextSync = sessionStorage.getItem('rollbux_profile_next_sync');
                if (nextSync === 'transactions') {
                    sessionStorage.removeItem('rollbux_profile_next_sync');
                    setTimeout(() => { window.location.href = 'https://rollbux.com/profile/transactions'; }, 800);
                } else if (returnTo === 'true') {
                    sessionStorage.removeItem('rollbux_return_to_main');
                    setTimeout(() => { window.location.href = 'https://rollbux.com/'; }, 800);
                }
            }
        }, 600);
        return;
    }

    // 2. On /profile/transactions: STRICT single row extraction
    if (path.includes('transactions')) {
        createOnScreenHUD();
        updateHUDTimer('SYNCING');

        async function extractTransactions() {
            const rainRewards = [];
            for (let attempt = 0; attempt < 12; attempt++) {
                await new Promise(r => setTimeout(r, 600));

                const rows = document.querySelectorAll('tr, [role="row"], div[class*="grid"], div[class*="row"]');
                for (const row of rows) {
                    const rowText = (row.innerText || row.textContent || '').trim();
                    if (!rowText.toLowerCase().includes('rain reward') && !rowText.toLowerCase().includes('rain payout')) continue;

                    let amountVal = 0;
                    const cells = Array.from(row.children);
                    for (const cell of cells) {
                        const cellText = (cell.innerText || cell.textContent || '').trim();
                        const match = cellText.match(/^[\s\+\$]*([\d,]+(?:\.\d+)?)/);
                        if (match && !cellText.toLowerCase().includes('reward') && !cellText.toLowerCase().includes('level')) {
                            const parsed = parseFloat(match[1].replace(/,/g, ''));
                            if (!isNaN(parsed) && parsed > 0 && parsed < 1000000) {
                                amountVal = parsed;
                                break;
                            }
                        }
                    }

                    if (amountVal === 0) {
                        const allNumbers = rowText.match(/[\d,]+(?:\.\d+)?/g);
                        if (allNumbers) {
                            for (const n of allNumbers) {
                                const parsed = parseFloat(n.replace(/,/g, ''));
                                if (!isNaN(parsed) && parsed > 0 && parsed < 50000) {
                                    amountVal = parsed;
                                    break;
                                }
                            }
                        }
                    }

                    let timeFormatted = formatNiceDate();
                    const dateMatch = rowText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}[^,\n]*)/);
                    if (dateMatch) {
                        timeFormatted = formatNiceDate(dateMatch[1]);
                    }

                    if (amountVal > 0) {
                        rainRewards.push({
                            type: 'Rain Reward',
                            amount_bux: amountVal,
                            time: timeFormatted,
                            status: 'Completed'
                        });
                    }
                }

                if (rainRewards.length > 0) break;
            }

            if (rainRewards.length > 0) {
                try {
                    const lastPot = parseFloat(sessionStorage.getItem('rollbux_last_pot') || '0') || null;
                    await requestLocal(BACKEND_URL, 'POST', {
                        username: currentUsername || 'Sotarium',
                        avatar: currentAvatarUrl,
                        action: 'sync_transactions',
                        completed_pot_amount: lastPot,
                        transactions: rainRewards
                    });
                    updateHUDTimer('SYNCED!');
                } catch (e) {
                    updateHUDTimer('ERROR');
                }
            } else {
                updateHUDTimer('NO DATA');
            }

            const redirectBack = sessionStorage.getItem('rollbux_return_to_main');
            if (redirectBack === 'true') {
                sessionStorage.removeItem('rollbux_return_to_main');
                setTimeout(() => { window.location.href = 'https://rollbux.com/'; }, 1000);
            }
        }

        extractTransactions();
        return;
    }

    // 3. On Main Page
    createOnScreenHUD();

    const sessionUserKnown = sessionStorage.getItem('rollbux_tracker_username');
    if (!sessionUserKnown) {
        sessionStorage.setItem('rollbux_tracker_username', 'pending');
        sessionStorage.setItem('rollbux_profile_next_sync', 'transactions');
        sessionStorage.setItem('rollbux_return_to_main', 'true');
        updateHUDTimer('USER...');
        setTimeout(() => { window.location.href = 'https://rollbux.com/profile'; }, 1500);
        return;
    }

    // Countdown & Rain Action Loop
    let currentRemainingSeconds = -1;
    let targetEndTimestamp = 0;
    let timerInitialized = false;
    let isSendingDots = false;
    let cycleCompleted = false;
    let joinedForCurrentRain = false;
    let lastKnownPot = parseFloat(sessionStorage.getItem('rollbux_last_pot') || '0') || 0;

    async function tickCountdown() {
        try {
            const bal = queryLiveBalance();
            if (bal !== null) updateHUDBalance(bal);

            const pot = queryRainPot();
            if (pot > 0) {
                updateHUDPot(pot);
                lastKnownPot = pot;
                sessionStorage.setItem('rollbux_last_pot', String(pot));
            }

            const siteSeconds = querySiteTimer();

            // Detect timer restart to fresh cycle (~55-60 minutes)
            if (siteSeconds > 600) {
                const pendingCheck = sessionStorage.getItem('rollbux_pending_payout_check');
                if (pendingCheck === 'true' || joinedForCurrentRain) {
                    sessionStorage.removeItem('rollbux_pending_payout_check');
                    joinedForCurrentRain = false;
                    sessionStorage.setItem('rollbux_return_to_main', 'true');
                    updateHUDTimer('SYNCING');
                    setTimeout(() => { window.location.href = 'https://rollbux.com/profile/transactions'; }, 1200);
                    return;
                }
                cycleCompleted = false;
                joinedForCurrentRain = false;
            }

            if (!timerInitialized || (targetEndTimestamp > 0 && Date.now() > targetEndTimestamp + 18000)) {
                if (siteSeconds > 0) {
                    currentRemainingSeconds = Math.max(0, siteSeconds - 60);
                    targetEndTimestamp = Date.now() + (currentRemainingSeconds * 1000);
                    timerInitialized = true;
                }
            }

            if (timerInitialized && targetEndTimestamp > 0) {
                const msLeft = targetEndTimestamp - Date.now();
                currentRemainingSeconds = Math.max(0, Math.ceil(msLeft / 1000));
            } else if (siteSeconds >= 0) {
                currentRemainingSeconds = siteSeconds;
            }

            // Sync all three live values to the website
            syncRainTick(pot, currentRemainingSeconds, bal);

            if (currentRemainingSeconds > 0) {
                const mins = Math.floor(currentRemainingSeconds / 60);
                const secs = currentRemainingSeconds % 60;
                updateHUDTimer(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
            } else if (currentRemainingSeconds === 0) {
                updateHUDTimer('00:00');

                if (!cycleCompleted && !isSendingDots) {
                    cycleCompleted = true;
                    isSendingDots = true;

                    (async () => {
                        try {
                            for (let i = 1; i <= 3; i++) {
                                await sendChatDot(i);
                                if (i < 3) await new Promise(r => setTimeout(r, 3800));
                            }
                            await new Promise(r => setTimeout(r, 1500));
                            clickJoinRain();
                            joinedForCurrentRain = true;
                        } catch (err) {
                        } finally {
                            isSendingDots = false;
                        }
                    })();
                }
            }
        } catch (e) {}
    }

    setInterval(tickCountdown, 1000);
    window.addEventListener('focus', tickCountdown);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tickCountdown();
    });
})();
