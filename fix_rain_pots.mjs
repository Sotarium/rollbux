// Ensure rain_total is always greater than amount_bux with a realistic participant ratio
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

const raw = fs.readFileSync(DATA_FILE, 'utf-8');
const users = JSON.parse(raw);

for (const key of Object.keys(users)) {
  const user = users[key];
  if (!Array.isArray(user.transactions)) continue;

  for (const tx of user.transactions) {
    const amt = parseFloat(tx.amount_bux) || 0;
    let pot = parseFloat(String(tx.rain_total || '0').replace(/,/g, '')) || 0;

    // A user reward is distributed across joined participants (typically user gets 2% to 20% of pot)
    // If the pot is less than or close to the user's reward, adjust the pot realistically!
    if (pot <= amt) {
      if (amt > 500) {
        // e.g. for 580.24, pot was likely a huge high-roller rain (e.g. 2,500 - 3,500 BUX)
        pot = Math.round(amt * (4.5 + Math.random() * 1.5) * 100) / 100;
      } else if (amt > 100) {
        // e.g. for 120.19, pot was likely 800 - 1,400 BUX
        pot = Math.round(amt * (5 + Math.random() * 3) * 100) / 100;
      } else if (amt > 50) {
        // e.g. for 60-99, pot was likely 400 - 900 BUX
        pot = Math.round(amt * (4 + Math.random() * 4) * 100) / 100;
      } else {
        // for smaller amounts, pot was at least 3x - 10x
        pot = Math.round(amt * (5 + Math.random() * 5) * 100) / 100;
      }
    }

    // Format nicely
    tx.rain_total = pot >= 1000
      ? pot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : pot.toFixed(2);
  }
}

fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf-8');
console.log('Fixed rain pots so rain_total is always logically larger than individual reward amount.');
