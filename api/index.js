'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const COOKIE = IS_PROD ? '__Host-pc_session' : 'pc_session';
const SESSION_DAYS = 7;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const ROOM_RE = /^[A-Z0-9]{6}$/;
const MESSAGE_MAX = 2000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- lazy config (a missing env var yields a clean 500, not a crash) ----
let _db;
function db() {
  if (_db) return _db;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase environment variables');
  _db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _db;
}
function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return s;
}

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const supaOrigin = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : '';
const supaWss = supaOrigin.replace(/^https/, 'wss');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', supaOrigin, supaWss].filter(Boolean),
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

if (!process.env.VERCEL) app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// CSRF defence in depth (cookie is also SameSite=Strict): reject cross-origin writes.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host || allowedOrigins.includes(origin)) return next();
  } catch { /* fall through */ }
  next(new HttpError(403, 'Unauthorized access'));
});

// ---- rate limiting (per serverless instance; see README) ----
const limiter = (windowMs, max, message) =>
  rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
const authLimiter = limiter(15 * 60 * 1000, 15, 'Too many attempts. Try again in a few minutes.');
const lookupLimiter = limiter(60 * 1000, 30, 'Too many requests. Slow down.');
const messageLimiter = limiter(60 * 1000, 60, 'You are sending messages too fast.');
app.use('/api', limiter(15 * 60 * 1000, 600, 'Too many requests. Try again later.'));

// ---- helpers ----
function normalizeRoomCode(v) {
  const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!ROOM_RE.test(code)) throw new HttpError(400, 'Invalid Room Code');
  return code;
}
function validateNewMember(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username))
    throw new HttpError(400, 'Username must be 3–24 characters: letters, numbers, dot, dash or underscore');
  if (password.length < 8 || Buffer.byteLength(password) > 72)
    throw new HttpError(400, 'Password must be 8–72 characters');
  if (password !== body.confirmPassword) throw new HttpError(400, 'Password confirmation does not match');
  return { username, password };
}
function generateRoomCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return c;
}
async function createMember(roomId, username, password) {
  const password_hash = await bcrypt.hash(password, 12);
  const { data, error } = await db()
    .from('members')
    .insert({ room_id: roomId, username, password_hash })
    .select('id, username')
    .single();
  if (error) {
    if (error.code === '23505') throw new HttpError(409, 'Username already exists');
    throw error;
  }
  return data;
}
async function startSession(res, memberId) {
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await db().from('sessions').delete().lt('expires_at', new Date().toISOString()); // housekeeping
  const { data, error } = await db()
    .from('sessions')
    .insert({ member_id: memberId, expires_at: expires.toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  const token = jwt.sign({ sid: data.id }, sessionSecret(), { algorithm: 'HS256', expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 86400 * 1000,
  });
}
const DUMMY_HASH = bcrypt.hashSync('privychat-dummy-password', 12); // equalises timing for unknown users

// ---- auth middleware: room + member always come from the DB, never from the client ----
const requireAuth = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) throw new HttpError(401, 'Authentication required');
  let payload;
  try { payload = jwt.verify(token, sessionSecret(), { algorithms: ['HS256'] }); }
  catch (e) {
    if (e.message && e.message.includes('SESSION_SECRET')) throw e;
    throw new HttpError(401, 'Authentication required');
  }
  const { data, error } = await db()
    .from('sessions')
    .select('id, expires_at, members(id, username, room_id, rooms(room_code))')
    .eq('id', payload.sid)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.members || new Date(data.expires_at) < new Date())
    throw new HttpError(401, 'Authentication required');
  const m = data.members;
  req.user = { id: m.id, username: m.username, roomId: m.room_id, roomCode: m.rooms.room_code, sid: data.id };
  next();
});

const api = express.Router();

// ---- public ----
api.get('/config', (req, res) => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Missing public Supabase configuration');
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

api.get('/rooms/:roomCode', lookupLimiter, wrap(async (req, res) => {
  const code = normalizeRoomCode(req.params.roomCode);
  const { data, error } = await db().from('rooms').select('id').eq('room_code', code).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Room not found');
  res.json({ exists: true });
}));

api.post('/rooms', wrap(async (req, res) => {
  const { username, password } = validateNewMember(req.body || {});
  let room = null;
  for (let i = 0; i < 6 && !room; i++) {
    const { data, error } = await db().from('rooms').insert({ room_code: generateRoomCode() }).select('id, room_code').single();
    if (!error) room = data;
    else if (error.code !== '23505') throw error; // 23505 = code collision, retry
  }
  if (!room) throw new Error('Could not allocate a room code');
  let member;
  try { member = await createMember(room.id, username, password); }
  catch (e) { await db().from('rooms').delete().eq('id', room.id); throw e; }
  await startSession(res, member.id);
  res.status(201).json({ roomCode: room.room_code, user: { username: member.username } });
}));

api.post('/auth/join', wrap(async (req, res) => {
  const body = req.body || {};
  const code = normalizeRoomCode(body.roomCode);
  const { username, password } = validateNewMember(body);
  const { data: room, error } = await db().from('rooms').select('id, room_code').eq('room_code', code).maybeSingle();
  if (error) throw error;
  if (!room) throw new HttpError(404, 'Room not found');
  const member = await createMember(room.id, username, password);
  await startSession(res, member.id);
  res.status(201).json({ roomCode: room.room_code, user: { username: member.username } });
}));

api.post('/auth/login', authLimiter, wrap(async (req, res) => {
  const body = req.body || {};
  const fail = () => new HttpError(401, 'Incorrect Room Code, username or password');
  const code = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!ROOM_RE.test(code)) throw new HttpError(400, 'Invalid Room Code');
  if (!username || !password || password.length > 128) throw fail();

  const { data: room, error: e1 } = await db().from('rooms').select('id').eq('room_code', code).maybeSingle();
  if (e1) throw e1;
  let member = null;
  if (room) {
    const pattern = username.replace(/[\\%_]/g, '\\$&'); // exact, case-insensitive match
    const { data, error: e2 } = await db()
      .from('members').select('id, username, password_hash')
      .eq('room_id', room.id).ilike('username', pattern).maybeSingle();
    if (e2) throw e2;
    member = data;
  }
  // Always run bcrypt so response time does not reveal whether the room/user exists.
  const ok = await bcrypt.compare(password, member ? member.password_hash : DUMMY_HASH);
  if (!member || !ok) throw fail();
  await startSession(res, member.id);
  res.json({ roomCode: code, user: { username: member.username } });
}));

api.post('/auth/logout', wrap(async (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, sessionSecret(), { algorithms: ['HS256'], ignoreExpiration: true });
      await db().from('sessions').delete().eq('id', payload.sid);
    } catch { /* invalid token: nothing to revoke */ }
  }
  res.clearCookie(COOKIE, { httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
}));

// ---- protected ----
api.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: { id: req.user.id, username: req.user.username },
    room: { id: req.user.roomId, roomCode: req.user.roomCode },
  });
});

// Short-lived token that lets the browser's Realtime connection see ONLY this member's room.
api.get('/realtime-token', requireAuth, (req, res) => {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('Missing SUPABASE_JWT_SECRET');
  const expiresIn = 3600;
  const token = jwt.sign(
    { aud: 'authenticated', role: 'authenticated', sub: req.user.id, room_id: req.user.roomId },
    secret, { algorithm: 'HS256', expiresIn }
  );
  res.json({ token, expiresIn });
});

api.get('/members', requireAuth, wrap(async (req, res) => {
  const { data, error } = await db()
    .from('members').select('id, username, created_at') // never password_hash
    .eq('room_id', req.user.roomId).order('created_at', { ascending: true });
  if (error) throw error;
  res.json({ members: data.map((m) => ({ id: m.id, username: m.username, createdAt: m.created_at })) });
}));

const shapeMessage = (r) => ({
  id: r.id, memberId: r.member_id, username: r.members ? r.members.username : null,
  message: r.message, createdAt: r.created_at,
});

api.get('/messages', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  let q = db().from('messages').select('id, member_id, message, created_at, members(username)')
    .eq('room_id', req.user.roomId).order('created_at', { ascending: false }).limit(limit);
  if (req.query.before) {
    const d = new Date(req.query.before);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid request');
    q = q.lt('created_at', d.toISOString());
  }
  const { data, error } = await q;
  if (error) throw error;
  res.json({ messages: data.reverse().map(shapeMessage) });
}));

api.post('/messages', requireAuth, messageLimiter, wrap(async (req, res) => {
  const text = typeof (req.body || {}).message === 'string' ? req.body.message.trim() : '';
  if (!text) throw new HttpError(400, 'Message cannot be empty');
  if (text.length > MESSAGE_MAX) throw new HttpError(400, `Message must be ${MESSAGE_MAX} characters or fewer`);
  const { data, error } = await db()
    .from('messages')
    .insert({ room_id: req.user.roomId, member_id: req.user.id, message: text })
    .select('id, member_id, message, created_at')
    .single();
  if (error) throw error;
  res.status(201).json({ message: { ...shapeMessage(data), username: req.user.username } });
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error('Unhandled error:', err && err.message); // message only: no stack, no payloads
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
