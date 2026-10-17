// api/roach/tick.js
// Multi-Account Serverless Cloud Worker for RainRoach
// Triggered by cron-job.org every 30-60s. Supports multiple accounts stored in Upstash Redis.

import { handleAction } from '../../server/db.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ENV_SESSION_TOKEN = process.env.ROLLBUX_SESSION_TOKEN;

const ROLLBUX_API_BASE = "https://rollbux.com/_api";

async function redis(command, ...args) {
  if (!UPSTASH_TOKEN) return null;
  const path = [command, ...args.map(a => encodeURIComponent(typeof a === 'object' ? JSON.stringify(a) : String(a)))].join('/');
  try {
    const res = await fetch(`${UPSTASH_URL}/${path}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error('[Roach Redis Error]', e);
    return null;
  }
}

async function rollbuxFetch(endpoint, sessionToken, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${ROLLBUX_API_BASE}${endpoint}`;
  const headers = {
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
    "Sec-Fetch-Site": "same-origin",
    ...(options.headers || {})
  };

  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
    headers["Cookie"] = `authjs.session-token=${sessionToken}`;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, data: JSON.parse(text) };
  } catch {
    return { ok: response.ok, status: response.status, data: text };
  }
}

export default async function handler(req, res) {
  const logs = [];
  const log = (msg) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
  };

  try {
    log("RainRoach multi-account tick triggered.");

    // 1. Fetch current rain state (public)
    const rainRes = await rollbuxFetch('/rain/current', null);
    if (!rainRes.ok || !rainRes.data || !rainRes.data.data) {
      log(`Failed to fetch rain state: HTTP ${rainRes.status}`);
      return res.status(200).json({ success: false, logs, error: "Rain state fetch failed" });
    }

    const rainData = rainRes.data.data;
    const cycle = rainData.cycle;
    const cycleId = cycle.id;
    const status = cycle.status;
    const cycleEnd = new Date(cycle.cycle_end).getTime();
    const now = Date.now();
    const secondsRemaining = Math.max(0, Math.round((cycleEnd - now) / 1000));
    const livePool = rainData.live_pool || 0;

    log(`Cycle: ${cycleId.slice(0, 8)} | Status: ${status} | Ends In: ${secondsRemaining}s | Pot: ${livePool}`);

    // 2. Fetch all registered accounts from Upstash
    let accountsRaw = await redis('get', 'roach:accounts');
    let accounts = accountsRaw ? JSON.parse(accountsRaw) : [];

    // Fallback: if no accounts in Redis but ENV token exists, treat as single account
    if (accounts.length === 0 && ENV_SESSION_TOKEN) {
      accounts = [{ id: 'env_main', name: 'Primary (ENV)', token: ENV_SESSION_TOKEN }];
    }

    log(`Registered accounts active: ${accounts.length}`);

    const results = [];

    // 3. Process each account individually
    for (const acc of accounts) {
      const accId = acc.id;
      const accName = acc.name;
      const token = acc.token;

      if (!token) {
        results.push({ account: accName, status: "NO_TOKEN" });
        continue;
      }

      // Check if this account already joined this cycle
      const joinedKey = `roach:joined:${cycleId}:${accId}`;
      let isAccountJoined = (await redis('get', joinedKey)) === '1';

      // Sync active rain tick to local player dashboard
      const potBux = parseFloat(((livePool || 0) / 1000000).toFixed(2));
      try {
        handleAction({
          action: 'rain_tick',
          username: accName,
          time_left: secondsRemaining,
          pot_amount: potBux
        });
      } catch (e) {}

      // Chat Keeper: Ensure 3 messages per hour for rain eligibility
      const chatKey = `roach:chat_count:${cycleId}:${accId}`;
      let chatCount = parseInt((await redis('get', chatKey)) || '0', 10);

      if (chatCount < 3 && secondsRemaining > 120 && secondsRemaining < 3300) {
        const emotes = [".", "gg", "gl", "rain", "<3", ":)", "!"];
        const randomMsg = emotes[Math.floor(Math.random() * emotes.length)];

        const chatRes = await rollbuxFetch('/users/chat', token, {
          method: 'POST',
          headers: { "Content-Type": "application/json" },
          body: { message: randomMsg }
        });

        if (chatRes.ok) {
          chatCount += 1;
          await redis('set', chatKey, chatCount);
          log(`[${accName}] Chat sent: "${randomMsg}" (${chatCount}/3)`);
        }
      }

      // Join Engine: Join when <= 60s and not joined
      let joinStatus = isAccountJoined ? "ALREADY_JOINED" : "WAITING";
      if (secondsRemaining <= 60 && status === 'COLLECTING' && !isAccountJoined) {
        log(`[${accName}] Attempting Rain Join...`);

        const joinRes = await rollbuxFetch('/users/me/rain/join', token, {
          method: 'POST',
          headers: { "Content-Type": "application/json" },
          body: { token: null }
        });

        if (joinRes.ok) {
          log(`[${accName}] JOIN SUCCESSFUL! 🎉`);
          await redis('set', joinedKey, '1');
          joinStatus = "SUCCESS";
          isAccountJoined = true;
        } else {
          log(`[${accName}] Join failed (HTTP ${joinRes.status}): ${JSON.stringify(joinRes.data)}`);
          joinStatus = `FAILED_${joinRes.status}`;
        }
      }

      results.push({
        id: accId,
        name: accName,
        joined: isAccountJoined,
        chat_count: chatCount,
        join_status: joinStatus
      });
    }

    // 4. Update overall status in Redis
    const dashboardState = {
      updated_at: new Date().toISOString(),
      cycle_id: cycleId,
      status,
      seconds_remaining: secondsRemaining,
      live_pool: livePool,
      accounts: results,
      last_logs: logs
    };
    await redis('set', 'roach:status', JSON.stringify(dashboardState));

    return res.status(200).json({
      success: true,
      cycle_id: cycleId,
      seconds_remaining: secondsRemaining,
      accounts: results,
      logs
    });
  } catch (err) {
    log(`Fatal Error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message, logs });
  }
}
