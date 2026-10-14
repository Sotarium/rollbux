import fs from 'fs';
import path from 'path';
import { handleAction, getUser, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from '../server/db.js';

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
  const pathname = url.pathname;

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
