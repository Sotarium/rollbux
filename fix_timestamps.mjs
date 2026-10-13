// Fix users.json:
// 1. Sync rains_joined to transaction count
// 2. Fill rain_total for transactions that have "X" using last_completed_pot
// 3. Space out bulk-imported same-timestamp transactions 1h apart
// 4. Rebuild earnings history from transactions for the chart

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

function formatFrenchDate(dateObj) {
  const d = dateObj || new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${hours}h${mins}`;
}

const ONE_HOUR = 3600 * 1000;

const raw = fs.readFileSync(DATA_FILE, 'utf-8');
const users = JSON.parse(raw);

for (const key of Object.keys(users)) {
  const user = users[key];
  if (!Array.isArray(user.transactions)) continue;
  const txs = user.transactions;

  // 1. Space out bulk-imported transactions with duplicate timestamps
  //    Scan tail of array for same-timestamp block
  if (txs.length > 0) {
    let i = txs.length - 1;
    const firstTs = txs[i].timestamp || 0;
    let dupeStart = i;
    while (i >= 0 && Math.abs((txs[i].timestamp || 0) - firstTs) < 2000) {
      dupeStart = i;
      i--;
    }
    const dupeCount = txs.length - dupeStart;
    if (dupeCount > 1) {
      const anchorTs = txs[dupeStart].timestamp || firstTs;
      for (let j = 0; j < dupeCount; j++) {
        const idx = dupeStart + j;
        txs[idx].timestamp = anchorTs - (j * ONE_HOUR);
        txs[idx].time = formatFrenchDate(new Date(txs[idx].timestamp));
      }
      console.log(`[${key}] Spaced ${dupeCount} bulk transactions 1h apart from anchor`);
    }

    // Also fix any other wrong time strings from their timestamps
    for (const tx of txs) {
      if (tx.timestamp) {
        const correct = formatFrenchDate(new Date(tx.timestamp));
        if (tx.time !== correct) {
          tx.time = correct;
        }
      }
    }
  }

  // 2. Fill rain_total = "X" entries using last_completed_pot (best available data)
  //    Use the active_rain.pot_amount as an approximation for all historical rains
  const potApprox = user.last_completed_pot || user.active_rain?.pot_amount || null;
  if (potApprox && potApprox > 0) {
    let filled = 0;
    for (const tx of txs) {
      if (tx.rain_total === 'X' || !tx.rain_total) {
        tx.rain_total = potApprox >= 1000
          ? potApprox.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : potApprox.toFixed(2);
        filled++;
      }
    }
    if (filled > 0) console.log(`[${key}] Filled ${filled} rain_total entries with ~${potApprox}`);
  }

  // 3. Sync rains_joined to actual transaction count
  const correct = Math.max(user.rains_joined || 0, txs.length);
  if (correct !== user.rains_joined) {
    console.log(`[${key}] rains_joined: ${user.rains_joined} -> ${correct}`);
    user.rains_joined = correct;
  }

  // 4. Rebuild earnings history from transactions for the chart (newest first -> sort ascending for chart)
  //    Build cumulative earnings over time, oldest to newest
  const sorted = [...txs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let cumulative = 0;
  user.history = sorted.map(tx => {
    cumulative += (tx.amount_bux || 0);
    return {
      time: new Date(tx.timestamp || Date.now()).toISOString(),
      balance_bux: cumulative,
      earnings_bux: tx.amount_bux
    };
  });
  console.log(`[${key}] Rebuilt history with ${user.history.length} chart points`);
}

fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf-8');
console.log('\nDone. Saved updated users.json');
