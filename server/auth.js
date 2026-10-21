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
  const response = await fetch(`${REDIS_URL}/${path}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  if (!response.ok) throw new Error(`Authentication storage request failed (${response.status})`);
  return (await response.json()).result;
}

function normalize(value) { return String(value || '').trim().toLowerCase(); }
function identifierKey(mode, identifier) { return `auth:identifier:${mode}:${encodeURIComponent(normalize(identifier))}`; }
function legacyEmailKey(email) { return `auth:user:${encodeURIComponent(normalize(email))}`; }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function publicUser(user) { return { id: user.id, username: user.username || null, email: user.email || null, identifierType: user.identifier_type }; }

function encodeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    username: user.username || null,
    email: user.email || null,
    identifierType: user.identifier_type || user.identifierType,
    exp: Date.now() + SESSION_TTL * 1000
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function sessionCookie(user) {
  const local = process.env.NODE_ENV === 'development';
  return `rb_session=${encodeSession(user)}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; SameSite=${local ? 'Lax' : 'None'}${local ? '' : '; Secure'}`;
}

export function clearSessionCookie() {
  const local = process.env.NODE_ENV === 'development';
  return `rb_session=; Max-Age=0; Path=/; HttpOnly; SameSite=${local ? 'Lax' : 'None'}${local ? '' : '; Secure'}`;
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
  } catch { return null; }
}

export async function signUp({ identifier, mode, password }) {
  requireConfig();
  mode = mode === 'email' ? 'email' : 'username';
  identifier = String(identifier || '').trim();
  const normalized = normalize(identifier);
  if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid email address');
  if (mode === 'username' && !/^[a-zA-Z0-9_]{3,24}$/.test(identifier)) throw new Error('Use 3–24 letters, numbers, or underscores');
  if (typeof password !== 'string' || password.length < 10) throw new Error('Password must be at least 10 characters');
  if (await redis('get', identifierKey(mode, normalized))) throw new Error(`That ${mode} is already in use`);
  const user = {
    id: crypto.randomUUID(),
    username: mode === 'username' ? identifier : null,
    email: mode === 'email' ? normalized : null,
    identifier_type: mode,
    password_hash: hashPassword(password),
    created_at: new Date().toISOString()
  };
  await redis('set', identifierKey(mode, normalized), JSON.stringify(user));
  return publicUser(user);
}

export async function signIn({ identifier, mode, password }) {
  mode = mode === 'email' ? 'email' : 'username';
  identifier = String(identifier || '').trim();
  if (!identifier || typeof password !== 'string') throw new Error('Enter your username or email and password');
  let raw = await redis('get', identifierKey(mode, normalize(identifier)));
  if (!raw && mode === 'email') raw = await redis('get', legacyEmailKey(identifier));
  const user = raw ? JSON.parse(raw) : null;
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('That login did not work');
  return publicUser(user);
}
