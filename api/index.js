import { handleAction, getUser, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from '../server/db.js';

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
  const pathname = url.pathname;

  if (pathname === '/api/status' && req.method === 'POST') {
    const payload = req.body || await parseBody(req);
    const result = handleAction(payload);
    res.status(200).json(result);
    return;
  }

  if (pathname.startsWith('/api/user/') && pathname.endsWith('/clear') && req.method === 'POST') {
    const username = decodeURIComponent(pathname.replace('/api/user/', '').replace('/clear', '')).trim();
    const user = clearUserStats(username);
    res.status(200).json({ ok: true, user });
    return;
  }

  if (pathname.startsWith('/api/user/')) {
    const username = decodeURIComponent(pathname.replace('/api/user/', '')).trim();
    const user = getUser(username);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const solPrice = getSolPrice();
    res.status(200).json({
      user,
      solPrice,
      solBalance: buxToSol(user.balance_bux),
      usdBalance: buxToUsd(user.balance_bux),
      solEarnings: buxToSol(user.total_earnings_bux),
      usdEarnings: buxToUsd(user.total_earnings_bux)
    });
    return;
  }

  if (pathname === '/api/users') {
    // Double-check IP at the API layer (middleware is the first gate)
    const ALLOWED_IP = '24.49.252.230';
    const clientIp = (
      req.headers['x-vercel-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      ''
    ).split(',')[0].trim();

    if (clientIp !== ALLOWED_IP) {
      res.status(403).end();
      return;
    }

    const users = getAllUsers();
    res.status(200).json({ users, solPrice: getSolPrice() });
    return;
  }

  res.status(404).json({ error: 'Not found' });
}
