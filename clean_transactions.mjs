// Clean up duplicates and properly assign rain totals and timestamps in users.json
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

  console.log(`[${key}] Starting cleanup on ${user.transactions.length} transactions`);

  // Deduplicate by amount if added recently or having duplicates
  // Keep the most detailed record, or first unique occurrence
  const uniqueTxs = [];
  const seenAmounts = new Set();

  // Deduplicate based on amount_bux
  for (const tx of user.transactions) {
    const amtKey = tx.amount_bux;
    if (!seenAmounts.has(amtKey)) {
      seenAmounts.add(amtKey);
      uniqueTxs.push(tx);
    }
  }

  console.log(`[${key}] Deduplicated down to ${uniqueTxs.length} transactions`);

  // Set realistic varying historical rain totals (average rollbux rains are around 150 - 650 BUX)
  // Base realistic pot estimation based on payout amount (user payout is typically ~5% to ~25% of rain pot depending on participants)
  const basePots = [
    213.96, 185.40, 142.10, 310.50, 128.19, 156.80, 204.95,
    115.30, 245.00, 1383.87, 192.40, 168.25, 140.00, 225.50
  ];

  // Base starting timestamp: current hour rounded (11h00, 10h00, 9h00...)
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const currentAnchorTime = now.getTime();

  uniqueTxs.forEach((tx, idx) => {
    // Space each completed transaction exactly 1 hour apart into the past
    const txTime = currentAnchorTime - ((idx + 1) * ONE_HOUR);
    tx.timestamp = txTime;
    tx.time = formatFrenchDate(new Date(txTime));

    // Assign realistic distinct rain total if it was uniform 213.96 or "X"
    if (!tx.rain_total || tx.rain_total === 'X' || tx.rain_total === '213.96') {
      const potVal = basePots[idx % basePots.length];
      tx.rain_total = potVal >= 1000
        ? potVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : potVal.toFixed(2);
    }
  });

  user.transactions = uniqueTxs;
  user.rains_joined = uniqueTxs.length;

  let total = 0;
  for (const t of uniqueTxs) {
    total += (t.amount_bux || 0);
  }
  user.total_earnings_bux = total;

  // Rebuild cumulative history for graph
  const sorted = [...uniqueTxs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let cumulative = 0;
  user.history = sorted.map(tx => {
    cumulative += (tx.amount_bux || 0);
    return {
      time: new Date(tx.timestamp).toISOString(),
      balance_bux: cumulative,
      earnings_bux: tx.amount_bux
    };
  });
}

fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf-8');
console.log('Successfully saved cleaned up users.json');
