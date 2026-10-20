import crypto from 'crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://flowing-chigger-149490.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN;
const SESSION_TTL = 60 * 60 * 24 * 7;

function requireConfig() {
  if (!REDIS_TOKEN || !SESSION_SECRET) throw new Error('Authentication storage is not configured');
}

async function redis(command, ...args) {
  requireConfig();
  const path = [command, ...args.map((value) => encodeURIComponent(String(value)))].join('/');
  const response = await fetch(`${REDIS_URL}/${path}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!response.ok) throw new Error(`Authentication storage request failed (${response.status})`);
  const data = await response.json();
  return data.result;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userKey(email) {
  return `auth:user:${encodeURIComponent(normalizeEmail(email))}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function encodeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    username: user.username,
    exp: Date.now() + SESSION_TTL * 1000
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function sessionCookie(user) {
  const isLocal = process.env.NODE_ENV === 'development';
  return `rb_session=${encodeSession(user)}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; SameSite=${isLocal ? 'Lax' : 'None'}${isLocal ? '' : '; Secure'}`;
}

export function clearSessionCookie() {
  const isLocal = process.env.NODE_ENV === 'development';
  return `rb_session=; Max-Age=0; Path=/; HttpOnly; SameSite=${isLocal ? 'Lax' : 'None'}${isLocal ? '' : '; Secure'}`;
}

export function currentSession(req) {
  const raw = String(req.headers?.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('rb_session='))?.slice('rb_session='.length);
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  const expected = sign(payload || '');
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export async function signUp({ email, username, password }) {
  requireConfig();
  email = normalizeEmail(email);
  username = String(username || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username must be 3–24 letters, numbers, or underscores');
  if (typeof password !== 'string' || password.length < 10) throw new Error('Password must be at least 10 characters');
  const existing = await redis('get', userKey(email));
  if (existing) throw new Error('An account with that email already exists');
  const user = { id: crypto.randomUUID(), email, username, password_hash: hashPassword(password), created_at: new Date().toISOString() };
  await redis('set', userKey(email), JSON.stringify(user));
  return { id: user.id, email: user.email, username: user.username };
}

export async function signIn({ email, password }) {
  email = normalizeEmail(email);
  if (!email || typeof password !== 'string') throw new Error('Email and password are required');
  const raw = await redis('get', userKey(email));
  const user = raw ? JSON.parse(raw) : null;
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');
  return { id: user.id, email: user.email, username: user.username };
}
