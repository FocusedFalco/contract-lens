import crypto from 'node:crypto';
import { db, tx, now } from './db.js';
import { httpError, wrap } from './util.js';

const SESSION_DAYS = 30;
const COOKIE = 'cl_session';
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// ------------------------------------------------------------------ passwords + tokens
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(pw, salt)).toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  const expected = Buffer.from(keyHex || '', 'hex');
  const got = await scrypt(pw, Buffer.from(saltHex || '', 'hex'));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
const DUMMY_HASH = await hashPassword('not-a-real-password'); // burn equal time for unknown emails
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const inviteCode = () => Array.from(crypto.randomBytes(8), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(tokenHash(token), userId, now(), expires.toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
const readToken = (req) => {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  if (bearer) return bearer[1];
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
};

// ------------------------------------------------------------------ login throttle (in-memory, per IP+email)
const attempts = new Map();
function throttle(key) {
  const t = Date.now(), rec = attempts.get(key);
  if (!rec || rec.reset < t) { attempts.set(key, { n: 1, reset: t + 10 * 60000 }); return; }
  if (++rec.n > 8) throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ------------------------------------------------------------------ validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validateSignup(b) {
  const email = clean(b.email, 254).toLowerCase(), name = clean(b.name, 100);
  if (!EMAIL_RE.test(email)) throw httpError(422, 'Enter a valid email address.', { field: 'email' });
  if (typeof b.password !== 'string' || b.password.length < 8) throw httpError(422, 'Password must be at least 8 characters.', { field: 'password' });
  if (b.password.length > 200) throw httpError(422, 'Password is too long.', { field: 'password' });
  if (name.length < 2) throw httpError(422, 'Enter your full name.', { field: 'name' });
  const phone = clean(b.phone, 30);
  if (phone && !/^[+\d][\d\s\-().]{6,24}$/.test(phone)) throw httpError(422, 'Enter a valid phone number, or leave it blank.', { field: 'phone' });
  if (!['customer', 'business'].includes(b.account_type)) throw httpError(422, 'Choose Individual or Business.', { field: 'account_type' });
  return { email, name, phone: phone || null, country: clean(b.country, 60) || null, job_title: clean(b.job_title, 80) || null };
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, country: u.country, job_title: u.job_title, account_type: u.account_type, org_id: u.org_id });

// ------------------------------------------------------------------ middleware + routes
export function loadContext(req) {
  const token = readToken(req);
  if (!token) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM session WHERE token_hash = ?').get(tokenHash(token));
  if (!s || s.expires_at < now()) return null;
  const user = db.prepare('SELECT * FROM user WHERE id = ?').get(s.user_id);
  if (!user) return null;
  let ownerKey = `user:${user.id}`, ownerName = user.name, org = null;
  if (user.account_type === 'business') {
    org = db.prepare('SELECT * FROM org WHERE id = ?').get(user.org_id);
    ownerKey = `org:${org.id}`; ownerName = org.name;
  }
  return { user, org, ownerKey, ownerName, orgName: org?.name || null, token };
}

export function requireUser(req, res, next) {
  const ctx = loadContext(req);
  if (!ctx) return next(httpError(401, 'Please sign in.'));
  req.ctx = ctx;
  next();
}

export function registerAuthRoutes(app) {
  app.post('/api/auth/signup', wrap(async (req, res) => {
    const b = req.body || {};
    const p = validateSignup(b);
    throttle(`signup:${req.ip}`);
    if (db.prepare('SELECT 1 FROM user WHERE email = ?').get(p.email)) throw httpError(409, 'An account with this email already exists. Try signing in.', { field: 'email' });

    let orgSpec = null;
    if (b.account_type === 'business') {
      const o = b.org || {};
      if (o.mode === 'join') {
        const code = clean(o.code, 20).toUpperCase().replace(/[\s-]/g, '');
        const org = db.prepare('SELECT id FROM org WHERE invite_code = ?').get(code);
        if (!org) throw httpError(422, "That invite code isn't valid. Ask your teammate for the code shown in their Settings.", { field: 'code' });
        orgSpec = { join: org.id };
      } else {
        const orgName = clean(o.name, 100);
        if (orgName.length < 2) throw httpError(422, 'Enter your organisation name.', { field: 'org_name' });
        orgSpec = { create: { name: orgName, industry: clean(o.industry, 60) || null } };
      }
    }
    const password_hash = await hashPassword(b.password);
    const userId = tx(() => {
      let orgId = null;
      if (orgSpec?.create) {
        orgId = Number(db.prepare('INSERT INTO org (name, industry, invite_code, created_at) VALUES (?,?,?,?)').run(orgSpec.create.name, orgSpec.create.industry, inviteCode(), now()).lastInsertRowid);
      } else if (orgSpec?.join) orgId = orgSpec.join;
      const id = Number(db.prepare('INSERT INTO user (name, email, password_hash, phone, country, job_title, account_type, org_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(p.name, p.email, password_hash, p.phone, p.country, p.job_title, b.account_type, orgId, now()).lastInsertRowid);
      if (orgId) db.prepare('INSERT INTO org_member (org_id, user_id, joined_at) VALUES (?,?,?)').run(orgId, id, now());
      return id;
    });
    startSession(res, userId);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM user WHERE id = ?').get(userId)) });
  }));

  app.post('/api/auth/signin', wrap(async (req, res) => {
    const email = clean(req.body?.email, 254).toLowerCase(), password = typeof req.body?.password === 'string' ? req.body.password : '';
    throttle(`signin:${req.ip}:${email}`);
    const user = db.prepare('SELECT * FROM user WHERE email = ?').get(email);
    const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok) throw httpError(401, 'Incorrect email or password.');
    attempts.delete(`signin:${req.ip}:${email}`);
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/auth/signout', (req, res) => {
    const t = readToken(req);
    if (t) db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash(t));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
}
