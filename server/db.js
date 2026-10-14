import fs from 'fs';
import path from 'path';

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_SERVERLESS ? '/tmp' : path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

// On serverless, initialize /tmp/users.json from project repo if missing
if (IS_SERVERLESS && !fs.existsSync(DATA_FILE)) {
  try {
    const defaultDataPath = path.resolve(process.cwd(), 'data', 'users.json');
    if (fs.existsSync(defaultDataPath)) {
      fs.copyFileSync(defaultDataPath, DATA_FILE);
    } else {
      fs.writeFileSync(DATA_FILE, '{}', 'utf-8');
    }
  } catch (e) {}
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let SOL_PRICE_USD = 150.00;

async function updateSolPrice() {
  // 1. Try CoinGecko API
  try {
    const headers = { 'Accept': 'application/json' };
    if (process.env.COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    }
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      headers
    });
    if (res.ok) {
      const json = await res.json();
      if (json && json.solana && json.solana.usd) {
        SOL_PRICE_USD = parseFloat(json.solana.usd);
        console.log(`[CoinGecko API] Live SOL price updated: $${SOL_PRICE_USD}`);
        return;
      }
    }
  } catch (err) {}

  // 2. Fallback to Coinbase if CoinGecko is rate-limited (HTTP 429)
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot');
    if (res.ok) {
      const json = await res.json();
      if (json && json.data && json.data.amount) {
        SOL_PRICE_USD = parseFloat(json.data.amount);
        console.log(`[Coinbase Fallback] Live SOL price updated: $${SOL_PRICE_USD}`);
        return;
      }
    }
  } catch (err) {}

  // 3. Fallback to Binance
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    if (res.ok) {
      const json = await res.json();
      if (json && json.price) {
        SOL_PRICE_USD = parseFloat(json.price);
        console.log(`[Binance Fallback] Live SOL price updated: $${SOL_PRICE_USD}`);
      }
    }
  } catch (err) {}
}

// Only run recurring price timer if not in a build process
if (process.env.npm_lifecycle_event !== 'build') {
  updateSolPrice();
  const timer = setInterval(updateSolPrice, 60000);
  if (timer.unref) timer.unref(); // Prevent timer from keeping the process alive
}

export function getSolPrice() {
  return SOL_PRICE_USD;
}

export function buxToUsd(bux) {
  return (parseFloat(bux) || 0) * 0.002;
}

export function buxToSol(bux) {
  const usd = buxToUsd(bux);
  return usd / SOL_PRICE_USD;
}

function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading users data:', err);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving users data:', err);
  }
}

export function getUser(username) {
  if (!username || username.toLowerCase().trim() === 'users') return null;
  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return users[key];

  const newUser = {
    username: username.trim(),
    avatar: 'https://rollbux.com/icons/token.png',
    balance_bux: 0,
    total_earnings_bux: 0,
    rains_joined: 0,
    first_tx_time: null,
    active_rain: {
      pot_amount: 0,
      time_left: 0,
      updated_at: Date.now()
    },
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    transactions: [],
    history: []
  };
  users[key] = newUser;
  saveUsers(users);
  return newUser;
}

export function clearUserStats(username) {
  if (!username) return null;
  const users = loadUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) {
    users[key].transactions = [];
    users[key].total_earnings_bux = 0;
    users[key].rains_joined = 0;
    users[key].history = [];
    users[key].first_tx_time = null;
    users[key].first_seen = new Date().toISOString();
    users[key].cleared_at = Date.now();
    saveUsers(users);
    return users[key];
  }
  return null;
}

export function getAllUsers() {
  return loadUsers();
}

function formatFrenchDate(dateObj) {
  const d = dateObj || new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${hours}h${mins}`;
}

export function handleAction(payload) {
  const { action, username, avatar, balance, pot_amount, time_left, pot_name, transactions } = payload;
  if (!username || username === 'Anonymous' || username === 'pending') {
    return { ok: true, ignored: true };
  }

  const users = loadUsers();
  const key = username.toLowerCase().trim();
  const now = new Date().toISOString();

  if (!users[key]) {
    users[key] = {
      username: username.trim(),
      avatar: avatar || 'https://rollbux.com/icons/token.png',
      balance_bux: 0,
      total_earnings_bux: 0,
      rains_joined: 0,
      first_tx_time: null,
      active_rain: {
        pot_amount: 0,
        time_left: 0,
        updated_at: Date.now()
      },
      first_seen: now,
      last_seen: now,
      transactions: [],
      history: []
    };
  }

  const user = users[key];
  user.last_seen = now;
  if (avatar) user.avatar = avatar;

  if (action === 'clear_stats') {
    user.transactions = [];
    user.total_earnings_bux = 0;
    user.rains_joined = 0;
    user.history = [];
    user.first_tx_time = null;
    user.cleared_at = Date.now();
    user.deleted_signatures = [];
    saveUsers(users);
    return { ok: true, user };
  }

  if (action === 'update_transaction') {
    const { index, time, rain_total, amount_bux } = payload;
    if (Array.isArray(user.transactions) && typeof index === 'number' && index >= 0 && index < user.transactions.length) {
      if (time) user.transactions[index].time = time;
      if (rain_total) user.transactions[index].rain_total = rain_total;
      if (typeof amount_bux === 'number') user.transactions[index].amount_bux = amount_bux;
      saveUsers(users);
    }
    return { ok: true, user };
  }

  if (action === 'delete_transaction') {
    const { timestamp, index, cycle_id, signature } = payload;
    if (!user.deleted_signatures) user.deleted_signatures = [];

    let removedTx = null;
    if (Array.isArray(user.transactions)) {
      if (typeof timestamp === 'number') {
        const found = user.transactions.find(t => t.timestamp === timestamp);
        if (found) removedTx = found;
        user.transactions = user.transactions.filter(t => t.timestamp !== timestamp);
      } else if (typeof index === 'number' && index >= 0 && index < user.transactions.length) {
        removedTx = user.transactions.splice(index, 1)[0];
      }

      // Add to permanent blacklist signatures
      if (cycle_id) user.deleted_signatures.push(String(cycle_id));
      if (signature) user.deleted_signatures.push(String(signature));
      if (removedTx) {
        if (removedTx.cycle_id) user.deleted_signatures.push(String(removedTx.cycle_id));
        const sig = `${removedTx.amount_bux}_${removedTx.time || ''}`;
        user.deleted_signatures.push(sig);
        if (removedTx.timestamp) user.deleted_signatures.push(String(removedTx.timestamp));
      }

      let total = 0;
      for (const t of user.transactions) {
        total += (t.amount_bux || 0);
      }
      user.total_earnings_bux = total;
      user.rains_joined = user.transactions.length;
      if (user.transactions.length === 0) {
        user.first_tx_time = null;
      }
      saveUsers(users);
    }
    return { ok: true, user };
  }

  if (action === 'rain_tick') {
    if (!user.active_rain) user.active_rain = {};
    if (typeof pot_amount === 'number' && pot_amount > 0) {
      // Track the last known pot before it resets
      user.active_rain.pot_amount = pot_amount;
      user.last_completed_pot = pot_amount; // save so sync_transactions can use it
    }
    if (typeof time_left === 'number') {
      user.active_rain.time_left = time_left;
    }
    user.active_rain.updated_at = Date.now();
    // Mark as in_progress so sync_transactions can promote it to completed in-place
    if (user.active_rain.status !== 'completed') {
      user.active_rain.status = 'in_progress';
    }
    if (typeof balance === 'number' && balance >= 0) {
      user.balance_bux = balance;
    }
  }

  if (action === 'balance_update') {
    if (typeof balance === 'number' && balance >= 0) {
      user.balance_bux = balance;
      user.history.push({
        time: now,
        balance_bux: balance
      });
      if (user.history.length > 500) user.history.shift();
    }
  }

  if (action === 'rain_joined') {
    user.rains_joined = (user.rains_joined || 0) + 1;
  }

  if (action === 'sync_transactions') {
    if (Array.isArray(transactions)) {
      if (!user.transactions) user.transactions = [];
      if (!user.deleted_signatures) user.deleted_signatures = [];

      // Use last known pot at time of rain completion
      const knownPot = payload.completed_pot_amount || user.last_completed_pot || null;

      for (const tx of transactions) {
        const amt = parseFloat(tx.amount_bux) || 0;
        if (amt <= 0) continue;

        // Timestamp = right now on the server
        const txTimestamp = Date.now();
        const displayTime = tx.time || formatFrenchDate(new Date(txTimestamp));

        // If user cleared their stats, do not re-import transactions older than cleared_at
        if (user.cleared_at && payload.sync_all_history && txTimestamp <= user.cleared_at) {
          continue;
        }

        // Check if permanently blacklisted/deleted by user
        const txSig = `${amt}_${displayTime}`;
        const isDeleted = user.deleted_signatures.some(d => {
          if (tx.cycle_id && String(d) === String(tx.cycle_id)) return true;
          if (String(d) === txSig) return true;
          return false;
        });
        if (isDeleted) {
          continue;
        }

        // Deduplicate: check cycle_id or same exact time and amount
        const alreadyInTxs = user.transactions.some(t => {
          if (tx.cycle_id && t.cycle_id && tx.cycle_id === t.cycle_id) return true;
          return t.time === displayTime && Math.abs(parseFloat(t.amount_bux) - amt) < 0.001;
        });
        // Also deduplicate against an already-promoted active_rain row
        const alreadyPromoted = user.active_rain &&
          user.active_rain.status === 'completed' &&
          Math.abs((user.active_rain.amount_bux || 0) - amt) < 0.001 &&
          user.active_rain.time === displayTime;

        if (!alreadyInTxs && !alreadyPromoted) {
          if (!user.first_tx_time) {
            user.first_tx_time = txTimestamp;
          }

          const rainTotalDisplay = knownPot
            ? (knownPot >= 1000
                ? knownPot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : knownPot.toFixed(2))
            : 'X';

          // If there is an "in_progress" active_rain, PROMOTE it in-place instead of a new row
          const hasInProgress = user.active_rain && user.active_rain.status === 'in_progress';
          if (hasInProgress) {
            user.active_rain.amount_bux = amt;
            user.active_rain.time = displayTime;
            user.active_rain.rain_total = rainTotalDisplay;
            user.active_rain.status = 'completed';
            user.active_rain.timestamp = txTimestamp;
            if (tx.cycle_id) user.active_rain.cycle_id = tx.cycle_id;
          } else {
            // No in_progress row — insert new completed transaction
            user.transactions.unshift({
              amount_bux: amt,
              rain_total: rainTotalDisplay,
              status: 'Completed',
              time: displayTime,
              timestamp: txTimestamp,
              cycle_id: tx.cycle_id || undefined
            });
          }
        }
      }

      let total = 0;
      for (const t of user.transactions) {
        total += (t.amount_bux || 0);
      }
      // Also count a promoted active_rain row in totals
      if (user.active_rain && user.active_rain.status === 'completed' && user.active_rain.amount_bux) {
        total += user.active_rain.amount_bux;
      }
      user.total_earnings_bux = total;
      // Keep rains_joined in sync with actual completed transactions
      user.rains_joined = Math.max(
        user.rains_joined || 0,
        user.transactions.length + (user.active_rain && user.active_rain.status === 'completed' ? 1 : 0)
      );
    }
  }

  // Repair action: regenerate time strings from timestamps for existing records
  if (action === 'fix_timestamps') {
    if (user.transactions) {
      for (const tx of user.transactions) {
        if (tx.timestamp) {
          tx.time = formatFrenchDate(new Date(tx.timestamp));
        }
      }
    }
  }

  saveUsers(users);
  return { ok: true, user };
}
