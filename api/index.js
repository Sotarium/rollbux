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
    return;
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

        // 3. Live Rain Transactions
        const txResp = await fetch("https://rollbux.com/_api/users/me/transactions", { headers: rollHeaders });
        if (txResp.ok) {
          const txData = await txResp.json();
          const items = txData?.data?.items || [];
          const rainTxs = items
            .filter(t => t.type === 'RAIN_REWARD')
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
