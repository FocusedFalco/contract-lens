// Security regression tests that need servers with different settings (access gate, public-host mode).
// Spawns its own throwaway servers on an embedded database with a minimal environment, so it can never touch
// your real database or API keys.   Run:  npm run test:security
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

let passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; } };

async function withServer(env, fn) {
  const port = 3500 + Math.floor(Math.random() * 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sec-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { PATH: process.env.PATH, CL_MODE: 'offline', PORT: String(port), CL_PGLITE_DIR: dir, CL_DATA_DIR: dir, ...env }, // nothing inherited: no DATABASE_URL, no keys
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/api/gate`); break; } catch { if (i > 80) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 250)); }
    }
    await fn(base);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CODE = 'correct-horse-battery-staple', SECRET = 'x'.repeat(48);
const post = (base, url, body = {}, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const setCookie = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const status = async (base, cookie) => (await fetch(`${base}/api/contracts`, { headers: cookie ? { cookie } : {} })).status;

console.log('ContractLens security tests');

await step('gate: closed without the code, wrong code refused, right code opens it with a signed expiring token', () =>
  withServer({ ACCESS_PASSWORD: CODE, SESSION_SECRET: SECRET }, async (base) => {
    assert.equal(await status(base), 401);
    assert.equal((await post(base, '/api/unlock', { code: 'wrong' })).status, 401);
    const ok = await post(base, '/api/unlock', { code: CODE });
    assert.equal(ok.status, 200);
    const set = setCookie(ok, 'cl_gate');
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
    const token = set.split(';')[0].slice('cl_gate='.length);
    assert.match(token, /^\d{13}\.[A-Za-z0-9_-]{43}$/, 'a signed expiring token, not a fixed value derived from the password');
    assert.equal(await status(base, `cl_gate=${token}`), 200);
  }));

await step('gate: tampered, expired, forged and legacy cookies are all rejected', () =>
  withServer({ ACCESS_PASSWORD: CODE, SESSION_SECRET: SECRET }, async (base) => {
    const token = setCookie(await post(base, '/api/unlock', { code: CODE }), 'cl_gate').split(';')[0].slice('cl_gate='.length);
    const [exp, sig] = token.split('.');
    const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64url');
    const past = Date.now() - 1000;
    const forged = {
      'flipped signature': `${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`,
      'extended expiry': `${Number(exp) + 86400000}.${sig}`,
      'expired but correctly signed': `${past}.${hmac(SECRET, `gate:${past}`)}`,
      'signed with the access code instead of the secret': `${Number(exp)}.${hmac(CODE, `gate:${exp}`)}`,
      'legacy fixed-value cookie': crypto.createHmac('sha256', CODE).update('contractlens-access').digest('hex'),
      'garbage': 'garbage', 'empty': '',
    };
    for (const [why, t] of Object.entries(forged)) assert.equal(await status(base, `cl_gate=${t}`), 401, why);
  }));

await step('gate: sign-out clears the cookie', () =>
  withServer({ ACCESS_PASSWORD: CODE, SESSION_SECRET: SECRET }, async (base) => {
    assert.match(setCookie(await post(base, '/api/lock'), 'cl_gate'), /Max-Age=0/);
  }));

await step('gate: unlock attempts are rate limited, even for the right code (counter lives in the database)', () =>
  withServer({ ACCESS_PASSWORD: CODE, SESSION_SECRET: SECRET }, async (base) => {
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await post(base, '/api/unlock', { code: `nope-${i}` })).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401), codes.join());
    assert.ok(codes.slice(10).every((c) => c === 429), codes.join());
    assert.equal((await post(base, '/api/unlock', { code: CODE })).status, 429);
  }));

await step('fail closed: a public host with no ACCESS_PASSWORD refuses to serve the API; with one it behaves normally', async () => {
  await withServer({ VERCEL: '1' }, async (base) => {
    for (const url of ['/api/session', '/api/contracts', '/api/gate']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 503, url); assert.match((await r.json()).error, /ACCESS_PASSWORD/);
    }
  });
  await withServer({ VERCEL: '1', ACCESS_PASSWORD: CODE, SESSION_SECRET: SECRET }, async (base) => assert.equal(await status(base), 401));
});

await step('errors: an unexpected failure returns a reference, not internals', () =>
  withServer({}, async (base) => {
    const r = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alert_windows: 5 }) }); // provokes a TypeError inside the handler
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /^Something went wrong on our side \(ref [0-9a-f]{8}\)\.$/);
  }));

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
