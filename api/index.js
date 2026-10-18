import fs from 'fs';
import path from 'path';
import { handleAction, getUser, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from '../server/db.js';
import roachTickHandler from './roach/tick.js';

const ALLOWED_IP = '24.49.252.230';

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
    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
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
    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
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

    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
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
        // Mask tokens in UI response for security
        const safeAccounts = accounts.map(a => ({
          id: a.id,
          name: a.name,
          token_preview: a.token ? `${a.token.slice(0, 8)}...${a.token.slice(-6)}` : '',
          created_at: a.created_at
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
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      let sessionToken = acc ? acc.token : process.env.ROLLBUX_SESSION_TOKEN;
      if (!sessionToken) {
        res.status(400).json({ success: false, error: "No account session token configured for " + targetName });
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

      // 2. Fetch live user balance
      const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
      if (!meResp.ok) {
        res.status(meResp.status).json({ success: false, error: "Failed to fetch user profile from RollBux" });
        return;
      }
      const meData = await meResp.json();
      const tokenBalanceMicro = meData?.data?.user?.token_balance || 0;
      const balanceBux = tokenBalanceMicro / 1000000;

      if (balanceBux < 50) {
        res.status(400).json({
          success: false,
          error: `Balance is ${balanceBux.toFixed(2)} BUX. Minimum required to play Upgrader is 50 BUX.`
        });
        return;
      }

      // Stake all in (or floor to whole BUX / micro-tokens)
      const stakeMicroTokens = Math.floor(tokenBalanceMicro);

      // 3. Fetch upgrader config to get rtpBP
      const configResp = await fetch("https://rollbux.com/_api/upgrader/config", { headers: rollHeaders });
      const configData = await configResp.json();
      const rtpBP = configData?.data?.rtpBP || 9000; // default 90% RTP (9000 BP)

      // 4. Fetch available target items
      const targetGoalMicroTokens = Math.floor(stakeMicroTokens * targetMultiplier);
      const targetsResp = await fetch("https://rollbux.com/_api/upgrader/targets?price=all&sortField=price&sortOrder=asc&limit=100", { headers: rollHeaders });
      const targetsData = await targetsResp.json();
      const items = targetsData?.data?.items || [];
      if (items.length === 0) {
        res.status(500).json({ success: false, error: "Could not fetch upgrader items catalog" });
        return;
      }

      // Find item closest to targetGoalMicroTokens (must be > stakeMicroTokens)
      const eligibleItems = items.filter(it => it.priceMicroTokens > stakeMicroTokens);
      if (eligibleItems.length === 0) {
        res.status(400).json({ success: false, error: "No eligible upgrade items found above current stake" });
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

      // 5. Calculate true provably fair chance
      // formula: chance = (stakeMicroTokens * (rtpBP / 10000)) / bestItem.priceMicroTokens
      const exactChance = Math.min(0.818181, Math.max(0.0001, (stakeMicroTokens * (rtpBP / 10000)) / bestItem.priceMicroTokens));

      // 6. Compute range [start, end]
      const Vt = 1000000;
      let startOffset = 0;
      if (isRandomPosition) {
        startOffset = Math.random();
      } else if (Array.isArray(payload.range) && typeof payload.range[0] === 'number') {
        startOffset = Math.max(0, Math.min(0.999999, payload.range[0]));
      }

      const startClamped = Number(startOffset.toFixed(6));
      const startInt = Math.round(startClamped * Vt);
      const chanceInt = Math.round(exactChance * Vt);
      const rawEnd = Math.max(1, startInt) + chanceInt - 1;
      const endNormalized = (rawEnd > Vt ? rawEnd % Vt : rawEnd) / Vt;
      const calculatedRange = [startClamped >= 1 ? 0.999999 : startClamped, endNormalized];

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
        res.status(playResp.status).json({
          success: false,
          error: playJson?.message || playJson?.error || playText || "Upgrade play rejected"
        });
        return;
      }

      const outcome = playJson?.data || {};
      res.status(200).json({
        success: true,
        won: Boolean(outcome.won),
        roll: outcome.roll,
        rollPrecision: outcome.rollPrecision || 1000000,
        range: calculatedRange,
        chancePercent: (exactChance * 100).toFixed(2),
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
        const accounts = accData.result ? JSON.parse(accData.result) : [];
        const match = accounts.find(a => (a.name || '').toLowerCase().trim() === username.toLowerCase().trim());
        if (match && match.token) {
          sessionToken = match.token;
        }
      }

      if (sessionToken) {
        const rollHeaders = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${sessionToken}`,
          "Cookie": `authjs.session-token=${sessionToken}`
        };

        // 1. Live Balance
        const balResp = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
        if (balResp.ok) {
          const balData = await balResp.json();
          if (balData?.data?.token_balance !== undefined) {
            const liveBalBux = parseFloat((balData.data.token_balance / 1000000).toFixed(2));
            handleAction({
              action: 'balance_update',
              username,
              balance: liveBalBux
            });
          }
        }

        // Live Rain Cycle & Countdown
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

        // 2. Live Avatar & Details
        const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
        if (meResp.ok) {
          const meData = await meResp.json();
          if (meData?.data?.user?.avatar_url) {
            handleAction({
              action: 'rain_tick',
              username,
              avatar: meData.data.user.avatar_url
            });
          }
        }

        // 3. Live Rain Transactions (only sync if user has not cleared their history, or only sync txs newer than cleared_at)
        const clearedAt = user.cleared_at || 0;
        const txResp = await fetch("https://rollbux.com/_api/users/me/transactions", { headers: rollHeaders });
        if (txResp.ok) {
          const txData = await txResp.json();
          const items = txData?.data?.items || [];
          const rainTxs = items
            .filter(t => {
              if (t.type !== 'RAIN_REWARD') return false;
              const txTime = typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime();
              return txTime > clearedAt;
            })
            .map(t => ({
              amount_bux: parseFloat(((t.amount || 0) / 1000000).toFixed(2)),
              time: new Date(t.date || Date.now()).toLocaleString('fr-FR', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
              }).replace(':', 'h'),
              cycle_id: t.id,
              timestamp: typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime()
            }));

          if (rainTxs.length > 0) {
            handleAction({
              action: 'sync_transactions',
              username,
              sync_all_history: true,
              transactions: rainTxs
            });
          }
        }
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
