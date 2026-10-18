import fs from 'fs';
import path from 'path';
import { handleAction, getUser, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from '../server/db.js';
import roachTickHandler from './roach/tick.js';

const ALLOWED_IP = '24.49.252.230';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAAkfyAAIgcDEyNjE1YWY1MGQ4YTQ0YmIwYjI3MzkyNDk1NWJkOTU2Mg";

function getClientIp(req) {
  return (
    req.headers['x-vercel-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    ''
  ).split(',')[0].trim();
}

function isAllowedIp(req) {
  const ip = getClientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  return ip === ALLOWED_IP;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function handleCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  handleCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'] || url.pathname;
  const pathname = rawPath.split('?')[0];


  // Roach Engine Routes
  if (pathname === '/api/roach/tick') {
    return roachTickHandler(req, res);
  }

  if (pathname === '/api/roach/status') {
    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ status: null, error: "Upstash token missing" });
      return;
    }
    try {
      const resp = await fetch(`${url}/get/roach%3Astatus`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      const statusObj = data.result ? JSON.parse(data.result) : null;
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ status: statusObj });
    } catch (e) {
      res.status(500).json({ status: null, error: e.message });
    }
    return;
  }

  // Roach Config (Auto Messages on/off toggle)
  if (pathname === '/api/roach/config') {
    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.status(200).json({ auto_messages: false, error: "Upstash token missing" });
      return;
    }

    if (req.method === 'GET') {
      try {
        const resp = await fetch(`${url}/get/roach%3Aconfig`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await resp.json();
        const conf = data.result ? JSON.parse(data.result) : { auto_messages: false };
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(conf);
      } catch (err) {
        res.status(500).json({ auto_messages: false, error: err.message });
      }
      return;
    }

    if (req.method === 'POST') {
      if (!isAllowedIp(req)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      try {
        const payload = req.body || await parseBody(req);
        const autoMessagesVal = Boolean(payload.auto_messages);
        const configObj = { auto_messages: autoMessagesVal, updated_at: new Date().toISOString() };
        
        await fetch(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([["SET", "roach:config", JSON.stringify(configObj)]])
        });

        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ success: true, config: configObj });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }
  }

  // Multi-Account Management Routes
  if (pathname === '/api/roach/accounts') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.status(500).json({ error: "Upstash token missing" });
      return;
    }

    if (req.method === 'GET') {
      try {
        const resp = await fetch(`${url}/get/roach%3Aaccounts`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await resp.json();
        const accounts = data.result ? JSON.parse(data.result) : [];

        // In parallel, fetch live cart (inventory) and balance for each account from RollBux
        const safeAccounts = await Promise.all(accounts.map(async (a) => {
          let cart = { count: 0, value: 0, items: [] };
          let liveBal = null;

          if (a.token) {
            const rollHeaders = {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "application/json, text/plain, */*",
              "Authorization": `Bearer ${a.token}`,
              "Cookie": `authjs.session-token=${a.token}`
            };

            try {
              const [invRes, balRes] = await Promise.all([
                fetch("https://rollbux.com/_api/users/me/inventory", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
                fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
              ]);

              if (invRes?.data) {
                const items = Array.isArray(invRes.data.items) ? invRes.data.items : [];
                cart = {
                  count: invRes.data.total_count !== undefined ? invRes.data.total_count : items.length,
                  value: parseFloat(((invRes.data.total_value || 0) / 1000000).toFixed(2)),
                  items: items
                };
              }

              if (balRes?.data?.token_balance !== undefined) {
                liveBal = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
                handleAction({
                  action: 'balance_update',
                  username: a.name,
                  balance: liveBal
                });
              }
            } catch (e) {}
          }

          return {
            id: a.id,
            name: a.name,
            token_preview: a.token ? `${a.token.slice(0, 8)}...${a.token.slice(-6)}` : '',
            created_at: a.created_at,
            cart,
            live_balance: liveBal
          };
        }));

        res.status(200).json({ accounts: safeAccounts });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const payload = req.body || await parseBody(req);
        if (!payload.name || !payload.token) {
          res.status(400).json({ error: "Name and token are required" });
          return;
        }

        const getResp = await fetch(`${url}/get/roach%3Aaccounts`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const getData = await getResp.json();
        let accounts = getData.result ? JSON.parse(getData.result) : [];

        // Remove existing entry with same name to avoid duplicates
        accounts = accounts.filter(a => (a.name||'').toLowerCase() !== payload.name.trim().toLowerCase());

        const newAccount = {
          id: `acc_${Date.now()}`,
          name: payload.name.trim(),
          token: payload.token.trim(),
          created_at: new Date().toISOString()
        };
        accounts.push(newAccount);

        // Use Upstash pipeline POST format — supports long values (JWT tokens)
        const setResp = await fetch(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([["SET", "roach:accounts", JSON.stringify(accounts)]])
        });
        const setData = await setResp.json();
        if (!Array.isArray(setData) || setData[0]?.result !== 'OK') {
          throw new Error(`Upstash SET failed: ${JSON.stringify(setData)}`);
        }

        res.status(200).json({ success: true, account: { id: newAccount.id, name: newAccount.name } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (req.method === 'DELETE') {
      try {
        const payload = req.body || await parseBody(req);
        const getResp2 = await fetch(`${url}/get/roach%3Aaccounts`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const getData2 = await getResp2.json();
        let accounts = getData2.result ? JSON.parse(getData2.result) : [];
        accounts = accounts.filter(a => a.id !== payload.id);

        // Use Upstash pipeline POST format — supports long values
        await fetch(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([["SET", "roach:accounts", JSON.stringify(accounts)]])
        });

        res.status(200).json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }
  }

  // Cart Item Selling Endpoint (Manual Sell / Auto-Sell for Upgrader)
  if (pathname === '/api/roach/accounts/cart/sell' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const accountId = payload.account_id;
      const accountName = (payload.name || '').toLowerCase().trim();
      const sellAll = payload.sell_all !== false;
      const inventoryIds = Array.isArray(payload.inventory_ids) ? payload.inventory_ids : null;

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      const accounts = accData.result ? JSON.parse(accData.result) : [];

      let targetAccount = null;
      if (accountId) {
        targetAccount = accounts.find(a => a.id === accountId);
      }
      if (!targetAccount && accountName) {
        targetAccount = accounts.find(a => (a.name || '').toLowerCase().trim() === accountName);
      }
      if (!targetAccount && accounts.length === 1) {
        targetAccount = accounts[0];
      }

      if (!targetAccount || !targetAccount.token) {
        res.status(404).json({ success: false, error: "Account or session token not found" });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${targetAccount.token}`,
        "Cookie": `authjs.session-token=${targetAccount.token}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/"
      };

      const sellBody = sellAll || !inventoryIds || inventoryIds.length === 0
        ? { sell_all: true }
        : { inventory_ids: inventoryIds };

      const sellRes = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify(sellBody)
      });

      const sellText = await sellRes.text();
      let sellJson = null;
      try { sellJson = JSON.parse(sellText); } catch {}

      if (!sellRes.ok) {
        res.status(sellRes.status).json({
          success: false,
          error: sellJson?.message || sellJson?.error || `Sell failed (HTTP ${sellRes.status})`,
          detail: sellJson || sellText
        });
        return;
      }

      // Fetch fresh balance and inventory
      let updatedBalance = null;
      let updatedCart = { count: 0, value: 0, items: [] };

      try {
        const [balRes, invRes] = await Promise.all([
          fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null),
          fetch("https://rollbux.com/_api/users/me/inventory", { headers: rollHeaders }).then(r => r.ok ? r.json() : null)
        ]);

        if (balRes?.data?.token_balance !== undefined) {
          updatedBalance = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
          handleAction({
            action: 'balance_update',
            username: targetAccount.name,
            balance: updatedBalance
          });
        }

        if (invRes?.data) {
          const items = Array.isArray(invRes.data.items) ? invRes.data.items : [];
          updatedCart = {
            count: invRes.data.total_count !== undefined ? invRes.data.total_count : items.length,
            value: parseFloat(((invRes.data.total_value || 0) / 1000000).toFixed(2)),
            items: items
          };
        }
      } catch (e) {}

      res.status(200).json({
        success: true,
        account: targetAccount.name,
        new_balance: updatedBalance,
        cart: updatedCart,
        result: sellJson
      });
      return;
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Test Chat Send for specific account
  if (pathname === '/api/roach/chat-test' && req.method === 'POST') {
    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const payload = req.body || await parseBody(req);
    const targetName = (payload.name || '').toLowerCase().trim();

    try {
      const resp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      let accounts = data.result ? JSON.parse(data.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      
      // Fallback: check ROLLBUX_SESSION_TOKEN env var if matching
      let sessionToken = acc ? acc.token : process.env.ROLLBUX_SESSION_TOKEN;
      if (!sessionToken) {
        res.status(400).json({ error: "No session token found for this account" });
        return;
      }

      const chatResp = await fetch("https://rollbux.com/_api/users/chat", {
        method: 'POST',
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`,
          "Cookie": `authjs.session-token=${sessionToken}`,
          "Origin": "https://rollbux.com",
          "Referer": "https://rollbux.com/"
        },
        body: JSON.stringify({ message: payload.message || "." })
      });

      const chatText = await chatResp.text();
      let chatJson = null;
      try { chatJson = JSON.parse(chatText); } catch {}

      if (chatResp.ok) {
        res.status(200).json({ success: true, status: chatResp.status, message: "Chat sent successfully!" });
      } else {
        res.status(chatResp.status).json({ success: false, status: chatResp.status, error: chatJson || chatText });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

  // Auto-Upgrader Execution Endpoint
  if (pathname === '/api/upgrader/play' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const targetMultiplier = Math.max(1.1, Math.min(100, parseFloat(payload.multiplier) || 2.0));
      const isRandomPosition = Boolean(payload.randomPosition);

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      // 1. Fetch account session token
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      // Case-insensitive, trimmed match
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : (payload.token || process.env.ROLLBUX_SESSION_TOKEN);
      if (!sessionToken) {
        const availableNames = accounts.map(a => a.name).join(', ');
        res.status(400).json({
          success: false,
          error: `No session token for "${targetName}". Available accounts: [${availableNames}]. Check your Redis store.`
        });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/games/upgrader"
      };

      // 2. Fetch live user balance from the dedicated RollBux balance endpoint
      let tokenBalanceMicro = 0;
      try {
        const balResp = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
        if (balResp.ok) {
          const balData = await balResp.json();
          if (balData?.data?.token_balance !== undefined) {
            tokenBalanceMicro = balData.data.token_balance;
          }
        }
      } catch (e) {
        console.error("[AutoUpgrader] Failed to fetch /users/me/balance:", e);
      }

      // Fallback 1: check profile endpoint
      if (!tokenBalanceMicro) {
        try {
          const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
          if (meResp.ok) {
            const meData = await meResp.json();
            tokenBalanceMicro = meData?.data?.user?.token_balance || meData?.data?.token_balance || 0;
          }
        } catch (e) {}
      }

      // Fallback 2: check local cached store balance
      if (!tokenBalanceMicro) {
        const localUser = getUser(targetName);
        if (localUser && localUser.balance_bux) {
          tokenBalanceMicro = Math.floor(localUser.balance_bux * 1000000);
        }
      }

      const balanceBux = tokenBalanceMicro / 1000000;

      if (balanceBux < 50) {
        res.status(400).json({
          success: false,
          error: `Balance is ${balanceBux.toFixed(2)} BUX. Minimum required to play Upgrader is 50 BUX.`
        });
        return;
      }

      // Stake amount: All In or custom BUX amount
      const betAmountRaw = String(payload.betAmount || '').trim().toLowerCase();
      let stakeMicroTokens = Math.floor(tokenBalanceMicro);
      if (betAmountRaw && betAmountRaw !== 'all in' && betAmountRaw !== 'allin' && betAmountRaw !== 'all') {
        const customBux = parseFloat(betAmountRaw);
        if (!isNaN(customBux) && customBux >= 50) {
          stakeMicroTokens = Math.min(stakeMicroTokens, Math.floor(customBux * 1000000));
        }
      }

      if (stakeMicroTokens < 50000000) {
        res.status(400).json({
          success: false,
          error: `Stake amount is ${(stakeMicroTokens / 1000000).toFixed(2)} BUX. Minimum required is 50 BUX.`
        });
        return;
      }

      // 3. Fetch upgrader config to get rtpBP
      const configResp = await fetch("https://rollbux.com/_api/upgrader/config", { headers: rollHeaders });
      const configData = await configResp.json();
      const rtpBP = configData?.data?.rtpBP || 9000; // default 90% RTP (9000 BP)

      // 4. Fetch available target items starting at >= 1.1x stake
      const minRequiredItemPrice = Math.ceil(stakeMicroTokens * 1.10);
      const targetGoalMicroTokens = Math.max(minRequiredItemPrice, Math.floor(stakeMicroTokens * targetMultiplier));
      const targetsResp = await fetch(`https://rollbux.com/_api/upgrader/targets?minPriceMicroTokens=${minRequiredItemPrice}&sortField=price&sortOrder=asc&limit=100`, { headers: rollHeaders });
      const targetsData = await targetsResp.json();
      const items = targetsData?.data?.items || [];
      if (items.length === 0) {
        res.status(400).json({ success: false, error: "No eligible upgrade items found worth at least 1.1x your stake" });
        return;
      }

      // Filter to ensure every eligible item strictly satisfies the 1.1x rule:
      const eligibleItems = items.filter(it => it.priceMicroTokens >= minRequiredItemPrice);
      if (eligibleItems.length === 0) {
        res.status(400).json({ success: false, error: "No eligible upgrade items found worth at least 1.1x your stake" });
        return;
      }

      let bestItem = eligibleItems[0];
      let smallestDiff = Infinity;
      for (const it of eligibleItems) {
        const diff = Math.abs(it.priceMicroTokens - targetGoalMicroTokens);
        if (diff < smallestDiff) {
          smallestDiff = diff;
          bestItem = it;
        }
      }

      // 5. Calculate true provably fair chance matching RollBux client exactly:
      // Dn formula: chancePPM = (stakeBI * rtpBI * 1000000n) / (targetBI * 10000n)
      const stakeBI = BigInt(stakeMicroTokens);
      const targetBI = BigInt(bestItem.priceMicroTokens);
      const rtpBI = BigInt(rtpBP || 9000);
      const chancePPM_BI = (stakeBI * rtpBI * 1000000n) / (targetBI * 10000n);
      const chancePercent = Number(chancePPM_BI) / 10000;
      const chance = chancePercent / 100;

      // 6. Compute range [start, end] using RollBux's exact Wt / Ht / Ut formulas:
      const Vt = 1000000;
      function Ht(e) {
        let t = Number(e.toFixed(6));
        return t >= 1 ? 0.999999 : t;
      }
      function Ut(e) {
        return (e > 1000000 ? e % Vt : e) / Vt;
      }
      function Wt(c, t) {
        let n = Ht(c);
        return [n, Ut(Math.max(1, Math.round(n * Vt)) + Math.round(t * Vt) - 1)];
      }

      let startOffset = 0;
      if (Array.isArray(payload.range) && typeof payload.range[0] === 'number') {
        startOffset = Math.max(0, Math.min(0.999999, payload.range[0]));
      } else if (isRandomPosition) {
        startOffset = Math.random();
      }

      const calculatedRange = Wt(startOffset, chance);

      // 7. Execute upgrade play on RollBux
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `upg_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const playResp = await fetch("https://rollbux.com/_api/upgrader/play", {
        method: 'POST',
        headers: {
          ...rollHeaders,
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          stakeValueMicroTokens: stakeMicroTokens,
          targetItemIds: [bestItem.itemId],
          range: calculatedRange,
          fast_mode: true
        })
      });

      const playText = await playResp.text();
      let playJson = null;
      try { playJson = JSON.parse(playText); } catch {}

      if (!playResp.ok) {
        let errMsg = "Upgrade play rejected";
        if (playJson?.error) {
          if (typeof playJson.error === 'string') {
            errMsg = playJson.error;
          } else if (playJson.error.message) {
            errMsg = playJson.error.message;
            if (playJson.error.details) {
              errMsg += ': ' + JSON.stringify(playJson.error.details);
            }
          } else {
            errMsg = JSON.stringify(playJson.error);
          }
        } else if (playJson?.message) {
          errMsg = playJson.message;
        } else if (playText) {
          errMsg = playText.slice(0, 200);
        }
        console.error(`[AutoUpgrader Error ${playResp.status}]:`, errMsg);
        res.status(playResp.status).json({
          success: false,
          error: errMsg
        });
        return;
      }

      const outcome = playJson?.data || {};
      const won = Boolean(outcome.won);
      let autoSold = false;
      let postBalanceBux = null;

      // Auto-sell won items back into liquid BUX balance if autoSell is enabled
      if (won && payload.autoSell !== false) {
        try {
          // Brief 300ms pause to ensure RollBux inventory record is committed
          await new Promise(r => setTimeout(r, 300));
          const sellResp = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
            method: 'POST',
            headers: rollHeaders,
            body: JSON.stringify({ sell_all: true })
          });

          if (sellResp.ok) {
            autoSold = true;
            // Fetch updated balance immediately
            const balResp2 = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
            if (balResp2.ok) {
              const bData = await balResp2.json();
              if (bData?.data?.token_balance !== undefined) {
                postBalanceBux = parseFloat((bData.data.token_balance / 1000000).toFixed(2));
                try {
                  handleAction({
                    action: 'balance_update',
                    username: targetName,
                    balance: postBalanceBux
                  });
                } catch (e) {}
              }
            }
          }
        } catch (sellErr) {
          console.error("[AutoUpgrader Auto-Sell Error]:", sellErr);
        }
      }

      res.status(200).json({
        success: true,
        account: acc ? acc.name : (targetName || 'Account'),
        won,
        autoSold,
        newBalanceBux: postBalanceBux,
        roll: outcome.roll,
        rollPrecision: outcome.rollPrecision || 1000000,
        range: calculatedRange,
        chancePercent: (chance * 100).toFixed(2),
        stakeBux: (stakeMicroTokens / 1000000).toFixed(2),
        targetItem: {
          id: bestItem.itemId,
          name: bestItem.name,
          imageUrl: bestItem.imageUrl,
          priceBux: (bestItem.priceMicroTokens / 1000000).toFixed(2)
        },
        outcome
      });
      return;
    } catch (e) {
      console.error("[AutoUpgrader Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Auto-Battle Creation Endpoint
  if (pathname === '/api/battles/create' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const borrowEnabled = payload.borrow !== false; // Default true as requested

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      // 1. Fetch account session token
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : (payload.token || process.env.ROLLBUX_SESSION_TOKEN);
      if (!sessionToken) {
        res.status(400).json({
          success: false,
          error: `No session token found for "${targetName}".`
        });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/games/battles/create"
      };

      // 2. Fetch live user balance
      let tokenBalanceMicro = 0;
      try {
        const balResp = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
        if (balResp.ok) {
          const balData = await balResp.json();
          if (balData?.data?.token_balance !== undefined) {
            tokenBalanceMicro = balData.data.token_balance;
          }
        }
      } catch (e) {
        console.error("[AutoBattle] Failed to fetch /users/me/balance:", e);
      }

      if (!tokenBalanceMicro) {
        try {
          const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
          if (meResp.ok) {
            const meData = await meResp.json();
            tokenBalanceMicro = meData?.data?.user?.token_balance || meData?.data?.token_balance || 0;
          }
        } catch (e) {}
      }

      const balanceBux = tokenBalanceMicro / 1000000;

      // 3. Fetch cases in 0 - 5,000 price range sorted by price/rarity ascending
      // RollBux micro-tokens: 5,000 BUX = 5,000,000,000 micro tokens
      const casesResp = await fetch("https://rollbux.com/_api/cases?limit=100", { headers: rollHeaders });
      if (!casesResp.ok) {
        res.status(500).json({ success: false, error: "Failed to fetch RollBux cases list" });
        return;
      }
      const casesData = await casesResp.json();
      const allCases = casesData?.data?.items || [];
      
      // Filter cases within 0 - 5,000 BUX (price <= 5,000,000,000)
      const maxPriceMicro = 5000 * 1000000;
      const validCases = allCases.filter(c => c.isActive !== false && c.price > 0 && c.price <= maxPriceMicro);

      // Sort by price (low to high) / rarity low
      validCases.sort((a, b) => a.price - b.price);

      if (validCases.length === 0) {
        res.status(400).json({ success: false, error: "No available cases in 0 - 5,000 BUX range" });
        return;
      }

      // 4. Select cases until Total Cost is closest to the account's total balance
      const cheapestCase = validCases[0];
      const minNeededBux = cheapestCase.price / 1000000;
      if (balanceBux < minNeededBux) {
      // Check if user already has an active battle to avoid "You have too many active battles" error
      try {
        const checkActiveResp = await fetch("https://rollbux.com/_api/battles", { headers: rollHeaders });
        if (checkActiveResp.ok) {
          const checkData = await checkActiveResp.json();
          const activeList = (checkData.data?.battles || []).filter(b => 
            (b.creator_id === acc?.token || b.players?.some(p => (p.username || '').toLowerCase() === targetName)) &&
            (b.status === 'waiting' || b.status === 'in_progress')
          );
          if (activeList.length > 0) {
            res.status(400).json({
              success: false,
              error: `You already have ${activeList.length} active battle in progress. Waiting for it to complete.`
            });
            return;
          }
        }
      } catch (e) {}

      // 4. Select cases starting from lowest to higher until cost is as close to balance as possible
      // In RollBux Borrow Mode (80% borrow), the user only pays 20% of the battle cost (Cost * 0.20 <= Balance).
      // That means allowed battle prize pool capacity is Balance / 0.20 = Balance * 5!
      const userEffectiveBorrowCostMultiplier = borrowEnabled ? 0.20 : 1.0;
      const cheapestCase = validCases[0];
      const cheapestUserCostBux = (cheapestCase.price / 1000000) * userEffectiveBorrowCostMultiplier;

      if (balanceBux < cheapestUserCostBux) {
        res.status(400).json({
          success: false,
          error: `Balance is ${balanceBux.toFixed(2)} BUX. Cheapest case "${cheapestCase.name}" costs ${cheapestUserCostBux.toFixed(2)} BUX.`
        });
        return;
      }

      // Max total nominal battle cost that the user's balance can fund
      const maxBattleNominalCostMicro = Math.floor(tokenBalanceMicro / userEffectiveBorrowCostMultiplier);

      // Start by picking the lowest priced cases and gradually add higher cases until the amount is too close to add another
      const selectedCases = [];
      let currentCostMicro = 0;

      // Iteratively pick cases from lowest upwards
      let canAddMore = true;
      while (canAddMore) {
        canAddMore = false;
        const remainingMicro = maxBattleNominalCostMicro - currentCostMicro;
        
        // Find best case that fits within remaining limit:
        // Prioritize starting from lowest prices upwards
        let chosenCase = null;
        for (let i = 0; i < validCases.length; i++) {
          if (validCases[i].price <= remainingMicro) {
            chosenCase = validCases[i];
          } else {
            // Once we encounter a case that doesn't fit, stop checking higher priced ones
            break;
          }
        }

        if (chosenCase) {
          selectedCases.push(chosenCase);
          currentCostMicro += chosenCase.price;
          canAddMore = true;
          // RollBux cap: up to 30 cases per battle
          if (selectedCases.length >= 30) break;
        }
      }

      if (selectedCases.length === 0) {
        selectedCases.push(cheapestCase);
        currentCostMicro = cheapestCase.price;
      }

      const totalCostBux = currentCostMicro / 1000000;
      const actualPaidBux = totalCostBux * userEffectiveBorrowCostMultiplier;

      // 5. Construct battle payload matching RollBux format
      const caseIds = selectedCases.map(c => c.id);
      const isCrazy = payload.crazy_mode !== undefined ? Boolean(payload.crazy_mode) : (Math.random() < 0.5);

      const battleBody = {
        case_ids: caseIds,
        game_mode: "3v3",
        modifiers: {
          crazy_mode: isCrazy,
          jackpot: false
        },
        settings: {
          special_spin: true,
          fast_open: false,
          private_mode: false,
          borrow: borrowEnabled ? { percentage: 80 } : undefined
        }
      };

      // 6. Post battle to RollBux
      const createResp = await fetch("https://rollbux.com/_api/battles", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify(battleBody)
      });

      const createText = await createResp.text();
      let createJson = null;
      try { createJson = JSON.parse(createText); } catch (e) {}

      if (!createResp.ok) {
        let errMsg = "Failed to create battle";
        if (createJson?.error) {
          if (typeof createJson.error === 'string') {
            errMsg = createJson.error;
          } else if (createJson.error.message) {
            errMsg = createJson.error.message;
            if (createJson.error.details) errMsg += ': ' + JSON.stringify(createJson.error.details);
          } else {
            errMsg = JSON.stringify(createJson.error);
          }
        } else if (createJson?.message) {
          errMsg = typeof createJson.message === 'string' ? createJson.message : JSON.stringify(createJson.message);
        } else if (createText) {
          errMsg = createText.slice(0, 200);
        }
        console.error(`[AutoBattle Error ${createResp.status}]:`, errMsg);
        res.status(createResp.status).json({ success: false, error: errMsg });
        return;
      }

      const battleResult = createJson?.data || createJson || {};
      const createdBattleId = battleResult.battle_id || battleResult.id;

      // 7. Auto-call bots to fill remaining slots (3v3 has slots 1 to 5)
      if (createdBattleId) {
        (async () => {
          for (let slot = 1; slot <= 5; slot++) {
            try {
              await new Promise(r => setTimeout(r, 400));
              await fetch(`https://rollbux.com/_api/battles/${createdBattleId}/bot`, {
                method: 'POST',
                headers: rollHeaders,
                body: JSON.stringify({ slot })
              });
            } catch (botErr) {
              // Ignore bot call error if slot fills or completes
            }
          }
        })().catch(() => {});
      }

      res.status(200).json({
        success: true,
        account: acc ? acc.name : (targetName || 'Account'),
        battle_id: createdBattleId,
        borrow: borrowEnabled,
        totalCostBux: totalCostBux.toFixed(2),
        actualPaidBux: actualPaidBux.toFixed(2),
        accountBalanceBux: balanceBux.toFixed(2),
        casesCount: selectedCases.length,
        cases: selectedCases.map(c => ({ id: c.id, name: c.name, priceBux: (c.price / 1000000).toFixed(2) })),
        result: battleResult
      });
      return;
    } catch (e) {
      console.error("[AutoBattle Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Battle History API endpoint
  if (pathname === '/api/battles/history' && req.method === 'GET') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const targetName = (url.searchParams.get('username') || 'sotarium').toLowerCase().trim();
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      
      let sessionToken = process.env.ROLLBUX_SESSION_TOKEN;
      if (redisToken) {
        const accResp = await fetch(`${redisUrl}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${redisToken}` } });
        const accData = await accResp.json();
        const accounts = accData.result ? JSON.parse(accData.result) : [];
        const acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName) || accounts[0];
        if (acc) sessionToken = acc.token;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`
      };

      const histResp = await fetch("https://rollbux.com/_api/battles/history?limit=50", { headers: rollHeaders });
      if (!histResp.ok) {
        res.status(histResp.status).json({ success: false, error: "Failed to fetch battles history" });
        return;
      }

      const histData = await histResp.json();
      const rawBattles = histData?.data?.items || [];

      // Filter and enrich battles for the target user
      const userBattles = [];
      for (const b of rawBattles) {
        // Check if user participated in this battle (or if creator/winner)
        const isUserInBattle = (b.winners || []).some(w => (w.username || '').toLowerCase() === targetName) ||
                               (b.players || []).some(p => (p.username || '').toLowerCase() === targetName);
        
        // Also fetch individual battle details if needed to get exact payout and cases
        let amountPaidBux = 0;
        let amountWonBux = 0;
        let didWin = false;

        const isWinner = (b.winners || []).some(w => (w.username || '').toLowerCase() === targetName);
        if (isWinner) {
          didWin = true;
        }

        // Nominal battle cost or prize pool
        const prizePoolBux = (b.prize_pool || b.cost || 0) / 1000000;
        // If borrow 80%, user paid 20%
        const isBorrow = Boolean(b.borrow || b.settings?.borrow);
        amountPaidBux = isBorrow ? (prizePoolBux * 0.20) : prizePoolBux;

        userBattles.push({
          battle_id: b.battle_id,
          game_mode: b.game_mode?.mode || '3v3',
          crazy_mode: Boolean(b.modifiers?.crazy_mode),
          borrow: isBorrow,
          prize_pool_bux: prizePoolBux.toFixed(2),
          amount_paid_bux: amountPaidBux.toFixed(2),
          amount_won_bux: didWin ? (prizePoolBux * (isBorrow ? 0.20 : 1.0)).toFixed(2) : "0.00",
          won: didWin,
          created_at: b.created_at ? (b.created_at * 1000) : Date.now(),
          completed_at: b.completed_at ? (b.completed_at * 1000) : null,
          winners: b.winners || [],
          url: `https://rollbux.com/games/battles/${b.battle_id}`
        });
      }

      res.status(200).json({
        success: true,
        battles: userBattles
      });
      return;
    } catch (e) {
      console.error("[Battles History Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Standalone Inventory Sell All Endpoint
  if (pathname === '/api/inventory/sell' && req.method === 'POST') {
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${token}` } });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : process.env.ROLLBUX_SESSION_TOKEN;
      if (!sessionToken) {
        res.status(400).json({ success: false, error: "No session token found" });
        return;
      }
      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/"
      };
      const sellResp = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify({ sell_all: true })
      });
      const sellJson = await sellResp.json().catch(() => ({}));
      res.status(sellResp.status).json({ success: sellResp.ok, data: sellJson });
      return;
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  if (pathname === '/roach') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'roach.html'),
        path.resolve(process.cwd(), 'roach.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Roach portal not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  if (pathname === '/api/status' && req.method === 'POST') {
    const payload = req.body || await parseBody(req);
    const result = handleAction(payload);
    res.status(200).json(result);
    return;
  }

  if (pathname.startsWith('/api/user/') && pathname.endsWith('/clear') && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const username = decodeURIComponent(pathname.replace('/api/user/', '').replace('/clear', '')).trim();
    const user = clearUserStats(username);

    // Save cleared state to Upstash so ephemeral serverless containers never forget the clear
    try {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (upstashToken) {
        const clearKey = `roach:cleared:${username.toLowerCase().trim()}`;
        await fetch(upstashUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(["SET", clearKey, String(Date.now())])
        });
      }
    } catch (e) {}

    res.status(200).json({ ok: true, user });
    return;
  }

  if (pathname.startsWith('/api/user/')) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const username = decodeURIComponent(pathname.replace('/api/user/', '')).trim();
    const user = getUser(username);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Cloud Roach Auto-Sync: Fetch live RollBux data directly using saved account token
    try {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      let sessionToken = process.env.ROLLBUX_SESSION_TOKEN;

      let allAccountsToSync = [];
      if (upstashToken) {
        // Sync cleared_at timestamp from Upstash if serverless instance lost it
        try {
          const clearCheck = await fetch(`${upstashUrl}/get/roach%3Acleared%3A${encodeURIComponent(username.toLowerCase())}`, {
            headers: { Authorization: `Bearer ${upstashToken}` }
          });
          const clearData = await clearCheck.json();
          if (clearData.result) {
            const savedClear = parseInt(clearData.result, 10);
            if (savedClear > (user.cleared_at || 0)) {
              user.cleared_at = savedClear;
              user.transactions = (user.transactions || []).filter(t => (t.timestamp || 0) > savedClear);
              let total = 0;
              user.transactions.forEach(t => total += (t.amount_bux || 0));
              user.total_earnings_bux = total;
              user.rains_joined = user.transactions.length;
            }
          }
        } catch (e) {}

        const accResp = await fetch(`${upstashUrl}/get/roach%3Aaccounts`, {
          headers: { Authorization: `Bearer ${upstashToken}` }
        });
        const accData = await accResp.json();
        allAccountsToSync = accData.result ? JSON.parse(accData.result) : [];
      }

      // If no accounts found in Redis, fall back to ENV token for the requested username
      if (allAccountsToSync.length === 0 && process.env.ROLLBUX_SESSION_TOKEN) {
        allAccountsToSync = [{ name: username, token: process.env.ROLLBUX_SESSION_TOKEN }];
      }

      // 1. Live Rain Cycle & Countdown (Fetch once publicly)
      try {
        const rainResp = await fetch("https://rollbux.com/_api/rain/current");
        if (rainResp.ok) {
          const rainData = await rainResp.json();
          const cycleEnd = rainData?.data?.cycle?.cycle_end;
          const livePool = rainData?.data?.live_pool || 0;
          if (cycleEnd) {
            const secondsLeft = Math.max(0, Math.floor((new Date(cycleEnd).getTime() - Date.now()) / 1000));
            const potBux = parseFloat((livePool / 1000000).toFixed(2));
            handleAction({
              action: 'rain_tick',
              username,
              time_left: secondsLeft,
              pot_amount: potBux
            });
          }
        }
      } catch (e) {}

      // 2. Iterate through ALL registered accounts to fetch balances and transactions concurrently
      const clearedAt = user.cleared_at || 0;
      const allRainTxs = [];

      await Promise.all(allAccountsToSync.map(async (acc) => {
        const accName = acc.name || 'Account';
        const sessionToken = acc.token;
        if (!sessionToken) return;

        const rollHeaders = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${sessionToken}`,
          "Cookie": `authjs.session-token=${sessionToken}`
        };

        const [balRes, meRes, txRes] = await Promise.all([
          fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch("https://rollbux.com/_api/users/me/transactions", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        if (balRes?.data?.token_balance !== undefined) {
          const liveBalBux = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
          handleAction({
            action: 'balance_update',
            username: accName,
            balance: liveBalBux
          });
          if (accName.toLowerCase() === username.toLowerCase()) {
            handleAction({
              action: 'balance_update',
              username,
              balance: liveBalBux
            });
          }
        }

        if (meRes?.data?.user?.avatar_url) {
          handleAction({
            action: 'rain_tick',
            username: accName,
            avatar: meRes.data.user.avatar_url
          });
        }

        if (txRes?.data?.items) {
          const items = txRes.data.items;
          const rainTxs = items
            .filter(t => {
              if (t.type !== 'RAIN_REWARD') return false;
              const txTime = typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime();
              return txTime > clearedAt;
            })
            .map(t => ({
              account: accName,
              amount_bux: parseFloat(((t.amount || 0) / 1000000).toFixed(2)),
              time: new Date(t.date || Date.now()).toLocaleString('fr-FR', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
              }).replace(':', 'h'),
              cycle_id: t.id ? `${accName}_${t.id}` : `${accName}_${t.date}_${t.amount}`,
              timestamp: typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime()
            }));

          allRainTxs.push(...rainTxs);
        }
      }));

      if (allRainTxs.length > 0) {
        handleAction({
          action: 'sync_transactions',
          username,
          sync_all_history: true,
          transactions: allRainTxs
        });
      }
    } catch (e) {
      console.error("Live cloud sync error:", e.message);
    }

    const updatedUser = getUser(username) || user;
    const solPrice = getSolPrice();
    res.status(200).json({
      user: updatedUser,
      solPrice,
      solBalance: buxToSol(updatedUser.balance_bux),
      usdBalance: buxToUsd(updatedUser.balance_bux),
      solEarnings: buxToSol(updatedUser.total_earnings_bux),
      usdEarnings: buxToUsd(updatedUser.total_earnings_bux)
    });
    return;
  }

  const matchedPath = req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'] || pathname;
  const isUsersPage = matchedPath === '/users' || matchedPath === '/users.html' || pathname === '/users' || pathname === '/users.html' || pathname === '/api/users-page' || url.searchParams.get('view') === 'users';
  const isUserDashboardPage = matchedPath.startsWith('/user/') || pathname.startsWith('/user/');

  // Protect the Individual User Profile Dashboard HTML page (/user/:username)
  if (isUserDashboardPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'dist', 'index.html'),
        path.resolve(process.cwd(), 'index.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Dashboard not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  const isAccountsPage = matchedPath === '/accounts' || matchedPath === '/accounts.html' || pathname === '/accounts' || pathname === '/accounts.html';

  // Protect the Accounts Management HTML page (/accounts)
  if (isAccountsPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'accounts.html'),
        path.resolve(process.cwd(), 'accounts.html'),
        path.resolve(process.cwd(), 'dist', 'accounts.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Accounts page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  const isHistoryPage = matchedPath === '/history' || matchedPath === '/history.html' || pathname === '/history' || pathname === '/history.html';

  // Serve the Battles History HTML page (/history)
  if (isHistoryPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'history.html'),
        path.resolve(process.cwd(), 'history.html'),
        path.resolve(process.cwd(), 'dist', 'history.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('History page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  // Protect the Active Users List HTML page (/users)
  if (isUsersPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'users.html'),
        path.resolve(process.cwd(), 'users.html'),
        path.resolve(process.cwd(), 'dist', 'users.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Users page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  // Protect the Users List JSON endpoint (/api/users)
  if (pathname === '/api/users') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const users = getAllUsers();
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ users, solPrice: getSolPrice() }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}
