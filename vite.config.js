import { defineConfig } from 'vite';
import http from 'http';
import { handleAction, getUser, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from './server/db.js';

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

function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (handleCors(req, res)) return;

  if (pathname === '/api/status' && req.method === 'POST') {
    const payload = await parseBody(req);
    const result = handleAction(payload);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
    return;
  }

  // Clear user stats endpoint
  if (pathname.startsWith('/api/user/') && pathname.endsWith('/clear') && req.method === 'POST') {
    const username = decodeURIComponent(pathname.replace('/api/user/', '').replace('/clear', '')).trim();
    const user = clearUserStats(username);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, user }));
    return;
  }

  if (pathname.startsWith('/api/user/')) {
    const username = decodeURIComponent(pathname.replace('/api/user/', '')).trim();
    const user = getUser(username);
    if (!user) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }
    const solPrice = getSolPrice();
    const solBalance = buxToSol(user.balance_bux);
    const usdBalance = buxToUsd(user.balance_bux);
    const solEarnings = buxToSol(user.total_earnings_bux);
    const usdEarnings = buxToUsd(user.total_earnings_bux);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      user,
      solPrice,
      solBalance,
      usdBalance,
      solEarnings,
      usdEarnings
    }));
    return;
  }

  if (pathname === '/api/users') {
    const users = getAllUsers();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ users, solPrice: getSolPrice() }));
    return;
  }
}

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  try {
    const compServer = http.createServer(async (req, res) => {
      if (req.url?.startsWith('/api/')) {
        await handleApiRequest(req, res);
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    });
    compServer.listen(8765, '0.0.0.0', () => {
      console.log('[API] Companion sync server listening on http://127.0.0.1:8765/api/status');
    });
    compServer.on('error', () => {});
  } catch (e) {}
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        users: './users.html'
      }
    }
  },
  plugins: [
    {
      name: 'rollbux-api-middleware',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url && req.url.startsWith('/api/')) {
            await handleApiRequest(req, res);
          } else if (req.url && (req.url === '/users' || req.url === '/users/')) {
            req.url = '/users.html';
            next();
          } else {
            next();
          }
        });
      }
    }
  ]
});
