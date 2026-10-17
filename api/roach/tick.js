// api/roach/tick.js
// Serverless Cloud Worker for RainRoach
// Runs in the cloud on Vercel, triggered by cron-job.org every 30-60 seconds.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ROLLBUX_TOKEN = process.env.ROLLBUX_SESSION_TOKEN;
const CAPTCHA_KEY = process.env.CAPMONSTER_KEY || process.env.NOPECHA_KEY || "";

const ROLLBUX_API_BASE = "https://rollbux.com/_api";

// Helper: Upstash Redis REST calls
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

// Helper: RollBux API call with Chrome headers
async function rollbuxFetch(endpoint, options = {}) {
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

  if (ROLLBUX_TOKEN) {
    headers["Authorization"] = `Bearer ${ROLLBUX_TOKEN}`;
    headers["Cookie"] = `authjs.session-token=${ROLLBUX_TOKEN}`;
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
    log("RainRoach tick triggered.");

    // 1. Fetch current rain state
    const rainRes = await rollbuxFetch('/rain/current');
    if (!rainRes.ok || !rainRes.data || !rainRes.data.data) {
      log(`Failed to fetch rain state: HTTP ${rainRes.status}`);
      return res.status(200).json({ success: false, logs, error: "Rain state fetch failed" });
    }

    const rainData = rainRes.data.data;
    const cycle = rainData.cycle;
    const cycleId = cycle.id;
    const status = cycle.status; // "COLLECTING"
    const cycleEnd = new Date(cycle.cycle_end).getTime();
    const now = Date.now();
    const secondsRemaining = Math.max(0, Math.round((cycleEnd - now) / 1000));
    const livePool = rainData.live_pool || 0;

    log(`Cycle: ${cycleId.slice(0, 8)}... | Status: ${status} | Ends In: ${secondsRemaining}s | Pot: ${livePool}`);

    // Read stored state from Redis
    const lastJoinedCycle = await redis('get', 'roach:last_joined_cycle');
    const isJoined = lastJoinedCycle === cycleId;

    // 2. Chat Keeper: Ensure 3 messages per hour for rain eligibility
    const chatKey = `roach:chat_count:${cycleId}`;
    let chatCount = parseInt((await redis('get', chatKey)) || '0', 10);

    // If rain is collecting and we have < 3 chats and more than 2 minutes left
    if (ROLLBUX_TOKEN && chatCount < 3 && secondsRemaining > 120 && secondsRemaining < 3300) {
      const emotes = [".", "gg", "gl", "rain", "<3", ":)", "!", "pog"];
      const randomMsg = emotes[Math.floor(Math.random() * emotes.length)];
      
      const chatRes = await rollbuxFetch('/users/chat', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: { content: randomMsg }
      });

      if (chatRes.ok) {
        chatCount += 1;
        await redis('set', chatKey, chatCount);
        log(`Chat posted: "${randomMsg}" (Count: ${chatCount}/3)`);
      } else {
        log(`Chat post failed: HTTP ${chatRes.status}`);
      }
    }

    // 3. Join Engine: When secondsRemaining <= 60s and not joined yet
    let joinResult = null;
    if (secondsRemaining <= 60 && status === 'COLLECTING' && !isJoined) {
      log("Rain is in join window (<= 60s)! Attempting join...");

      if (!ROLLBUX_TOKEN) {
        log("Cannot join: ROLLBUX_SESSION_TOKEN is missing from environment variables.");
      } else {
        // Attempt join
        const joinRes = await rollbuxFetch('/users/me/rain/join', {
          method: 'POST',
          headers: { "Content-Type": "application/json" },
          body: { token: null }
        });

        if (joinRes.ok) {
          log("Successfully joined rain!");
          await redis('set', 'roach:last_joined_cycle', cycleId);
          joinResult = "SUCCESS";
        } else {
          log(`Join returned HTTP ${joinRes.status}: ${JSON.stringify(joinRes.data)}`);
          joinResult = `FAILED_${joinRes.status}`;
        }
      }
    }

    // 4. Save latest status in Upstash for dashboard
    const dashboardState = {
      updated_at: new Date().toISOString(),
      cycle_id: cycleId,
      status,
      seconds_remaining: secondsRemaining,
      live_pool: livePool,
      is_joined: isJoined || joinResult === "SUCCESS",
      chat_count: chatCount,
      last_logs: logs
    };
    await redis('set', 'roach:status', JSON.stringify(dashboardState));

    return res.status(200).json({
      success: true,
      cycle_id: cycleId,
      seconds_remaining: secondsRemaining,
      live_pool: livePool,
      is_joined: isJoined || joinResult === "SUCCESS",
      join_attempted: joinResult,
      logs
    });
  } catch (err) {
    log(`Fatal Error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message, logs });
  }
}
