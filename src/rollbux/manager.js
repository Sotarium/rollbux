// src/rollbux/manager.js
// RainRoach Standalone Worker Engine
// Can run locally or on any server 24/7 without a browser.

import { execFile } from 'child_process';
import path from 'path';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAAkfyAAIgcDEyNjE1YWY1MGQ4YTQ0YmIwYjI3MzkyNDk1NWJkOTU2Mg";
const ROLLBUX_TOKEN = process.env.ROLLBUX_SESSION_TOKEN || "";

const ROLLBUX_API_BASE = "https://rollbux.com/_api";

async function redis(command, ...args) {
  if (!UPSTASH_TOKEN) return null;
  const urlPath = [command, ...args.map(a => encodeURIComponent(typeof a === 'object' ? JSON.stringify(a) : String(a)))].join('/');
  try {
    const res = await fetch(`${UPSTASH_URL}/${urlPath}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    return null;
  }
}

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

console.log("==========================================");
console.log("🪳 RainRoach Headless Worker Initialized");
console.log("Upstash Redis Connected:", !!UPSTASH_TOKEN);
console.log("Session Token Loaded:", !!ROLLBUX_TOKEN);
console.log("==========================================");

let isJoining = false;

async function tick() {
  try {
    const rainRes = await rollbuxFetch('/rain/current');
    if (!rainRes.ok || !rainRes.data || !rainRes.data.data) {
      console.log(`[${new Date().toLocaleTimeString()}] Rain fetch error (HTTP ${rainRes.status})`);
      return;
    }

    const { cycle, live_pool } = rainRes.data.data;
    const cycleId = cycle.id;
    const status = cycle.status;
    const cycleEnd = new Date(cycle.cycle_end).getTime();
    const secondsRemaining = Math.max(0, Math.round((cycleEnd - Date.now()) / 1000));
    const potBux = (live_pool / 10000000).toFixed(2);

    const lastJoined = await redis('get', 'roach:last_joined_cycle');
    const isJoined = lastJoined === cycleId;

    console.log(`[${new Date().toLocaleTimeString()}] Cycle: ${cycleId.slice(0, 8)} | Time: ${secondsRemaining}s | Pot: ${potBux} BUX | Joined: ${isJoined ? 'YES' : 'NO'}`);

    // Update status in Upstash
    await redis('set', 'roach:status', JSON.stringify({
      updated_at: new Date().toISOString(),
      cycle_id: cycleId,
      status,
      seconds_remaining: secondsRemaining,
      live_pool,
      is_joined: isJoined
    }));

    // Auto-join at <= 60s
    if (secondsRemaining <= 60 && status === 'COLLECTING' && !isJoined && !isJoining) {
      if (!ROLLBUX_TOKEN) {
        console.log("⚠️ Join window reached, but ROLLBUX_SESSION_TOKEN is not set!");
        return;
      }

      isJoining = true;
      console.log("🚨 [RainRoach] Triggering Rain Join now...");

      const joinRes = await rollbuxFetch('/users/me/rain/join', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: { token: null }
      });

      if (joinRes.ok) {
        console.log("🎉 Successfully joined the rain!");
        await redis('set', 'roach:last_joined_cycle', cycleId);
      } else {
        console.log(`❌ Join failed (HTTP ${joinRes.status}):`, joinRes.data);
      }
      isJoining = false;
    }
  } catch (err) {
    console.error('[Tick Error]', err.message);
  }
}

// Tick immediately then every 10 seconds
tick();
setInterval(tick, 10000);
