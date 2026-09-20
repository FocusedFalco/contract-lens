// End-to-end API smoke test. Run against a server started with a FRESH data dir, e.g.:
//   CL_DATA_DIR=/tmp/cl-test PORT=3299 npm start &   then   BASE=http://localhost:3299 npm test
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3210';
const S = (f) => path.join('samples', f);
let passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; } };

// uid 1 = individual, 2 = business (creates org), 3 = business teammate (joins via invite code). Real accounts, bearer tokens.
const tokens = {};
async function api(method, url, { uid = 2, body, form, noAuth } = {}) {
  const res = await fetch(BASE + '/api' + url, {
    method, headers: { ...(noAuth || !tokens[uid] ? {} : { authorization: `Bearer ${tokens[uid]}` }), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => null);
  const cookie = res.headers.get('set-cookie');
  return { status: res.status, data, token: cookie && /cl_session=([^;]+)/.exec(cookie)?.[1] };
}
const P = { password: 'correct-horse-9', phone: '+91 98765 43210', country: 'India' };
async function signup(uid, extra) { const r = await api('POST', '/auth/signup', { noAuth: true, body: { ...P, ...extra } }); if (r.token) tokens[uid] = r.token; return r; }
async function upload(file, uid = 2, q = '') {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(S(file))], { type: 'application/pdf' }), file);
  return api('POST', `/contracts${q}`, { uid, form });
}
async function ready(id, uid = 2) {
  for (let i = 0; i < 60; i++) {
    const { data } = await api('GET', `/contracts/${id}`, { uid });
    if (!['processing'].includes(data.contract.status)) return data;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out waiting for extraction');
}
const ackAll = (d) => ({
  acknowledged_fields: d.fields.filter((f) => f.confidence !== 'high').map((f) => f.field_name),
  acknowledged_flags: d.flags.map((f) => f.id),
});
const confirmBody = (d, vendorName, extra = {}) => ({ title: d.contract.title, contract_type: d.contract.contract_type, vendor: { name: vendorName }, ...ackAll(d), ...extra });

console.log(`ContractLens smoke test → ${BASE}`);
const ids = {};

await step('AUTH: unauthenticated requests are rejected', async () => {
  assert.equal((await api('GET', '/contracts', { noAuth: true })).status, 401);
  assert.equal((await api('GET', '/session', { noAuth: true })).status, 401);
});
await step('AUTH: sign-up validates input and stores personal details', async () => {
  assert.equal((await signup(9, { email: 'bad', name: 'A B', account_type: 'customer' })).status, 422);
  assert.equal((await signup(9, { email: 'x@y.com', password: 'short', name: 'A B', account_type: 'customer' })).status, 422);
  assert.equal((await signup(9, { email: 'x@y.com', name: 'A', account_type: 'customer' })).status, 422, 'name too short');
  assert.equal((await signup(9, { email: 'x@y.com', name: 'A B', account_type: 'nope' })).status, 422);
  assert.equal((await signup(9, { email: 'x@y.com', name: 'A B', account_type: 'business', org: { mode: 'create', name: '' } })).status, 422, 'org name required');
  assert.equal((await signup(9, { email: 'x@y.com', name: 'A B', account_type: 'business', org: { mode: 'join', code: 'NOPE1234' } })).status, 422, 'bad invite code');
  const r = await signup(1, { email: 'Aarav@Example.com', name: 'Aarav Mehta', job_title: 'Engineer', account_type: 'customer' });
  assert.equal(r.status, 201); assert.ok(r.token);
  const me = (await api('GET', '/session', { uid: 1 })).data;
  assert.equal(me.user.email, 'aarav@example.com', 'email normalised'); assert.equal(me.user.phone, P.phone); assert.equal(me.user.country, 'India'); assert.equal(me.user.job_title, 'Engineer'); assert.equal(me.user.account_type, 'customer');
  assert.ok(!('password_hash' in me.user) && !JSON.stringify(me).includes('scrypt'), 'no password hash leaked');
});
await step('AUTH: duplicate email rejected; wrong password rejected; sign-in works; sign-out revokes the session', async () => {
  assert.equal((await signup(9, { email: 'AARAV@example.com', name: 'Dup Licate', account_type: 'customer' })).status, 409);
  assert.equal((await api('POST', '/auth/signin', { noAuth: true, body: { email: 'aarav@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await api('POST', '/auth/signin', { noAuth: true, body: { email: 'nobody@example.com', password: 'whatever123' } })).status, 401);
  const ok = await api('POST', '/auth/signin', { noAuth: true, body: { email: 'aarav@example.com', password: P.password } });
  assert.equal(ok.status, 200); tokens.tmp = ok.token;
  assert.equal((await api('GET', '/session', { uid: 'tmp' })).status, 200);
  await api('POST', '/auth/signout', { uid: 'tmp' });
  assert.equal((await api('GET', '/session', { uid: 'tmp' })).status, 401, 'token revoked');
});
await step('BUSINESS: create org, teammate joins with invite code, both have identical full access', async () => {
  assert.equal((await signup(2, { email: 'priya@acme.example', name: 'Priya Nair', account_type: 'business', org: { mode: 'create', name: 'Acme Traders Pvt Ltd', industry: 'Retail & e-commerce' } })).status, 201);
  const org = (await api('GET', '/org', { uid: 2 })).data;
  assert.equal(org.name, 'Acme Traders Pvt Ltd'); assert.match(org.invite_code, /^[A-Z2-9]{8}$/);
  assert.equal((await signup(3, { email: 'karan@acme.example', name: 'Karan Shah', account_type: 'business', org: { mode: 'join', code: org.invite_code.toLowerCase() } })).status, 201);
  assert.equal((await api('GET', '/org', { uid: 3 })).data.members.length, 2);
  assert.equal((await api('GET', '/org', { uid: 1 })).data, null, 'individuals have no org');
});

await step('upload + extraction produce fields (low confidence first), flags, paragraphs, summary', async () => {
  const r = await upload('nimbus-master-services-agreement.pdf');
  assert.equal(r.status, 202); ids.msa = r.data.id;
  const d = await ready(ids.msa);
  assert.equal(d.contract.status, 'pending_review');
  assert.equal(d.fields.length, 7);
  const order = d.fields.map((f) => f.confidence);
  assert.deepEqual(order, [...order].sort((a, b) => ({ low: 0, medium: 1, high: 2 })[a] - ({ low: 0, medium: 1, high: 2 })[b]), 'fields sorted low→high');
  assert.ok(d.flags.length >= 5 && d.flags.every((f) => f.source), 'every flag cites a source paragraph');
  assert.ok(d.fields.every((f) => f.confidence && (f.value === null || f.source_refs.length)), 'every non-null field has a citation + confidence');
  assert.ok(d.contract.summary_text.length > 100);
});

await step('duplicate upload is rejected unless allowed', async () => {
  const r = await upload('nimbus-master-services-agreement.pdf');
  assert.equal(r.status, 409); assert.equal(r.data.duplicate_of, ids.msa);
});

await step('MANDATORY REVIEW: cannot confirm without acknowledging low/medium fields and flags', async () => {
  const d = await ready(ids.msa);
  const r = await api('POST', `/contracts/${ids.msa}/confirm`, { body: { title: 'x', contract_type: 'business_class', vendor: { name: 'Nimbus Cloud Solutions Pvt Ltd' } } });
  assert.equal(r.status, 422);
  assert.ok(r.data.missing_flags.length === d.flags.length && r.data.missing_fields.includes('expiration_date'));
  assert.equal((await ready(ids.msa)).contract.status, 'pending_review', 'still pending after refused confirm');
});

await step('validation: bad date is rejected', async () => {
  const d = await ready(ids.msa);
  const r = await api('POST', `/contracts/${ids.msa}/confirm`, { body: confirmBody(d, 'Nimbus Cloud Solutions Pvt Ltd', { fields: { expiration_date: '31/12/2026' } }) });
  assert.equal(r.status, 422);
});

await step('confirm → active; corrections stored alongside the original extraction', async () => {
  const d = await ready(ids.msa);
  const corrected = { ...d.fields.find((f) => f.field_name === 'payment_terms').value, amount: 4600 };
  const r = await api('POST', `/contracts/${ids.msa}/confirm`, { body: confirmBody(d, 'Nimbus Cloud Solutions Pvt Ltd', { title: 'Nimbus MSA', fields: { payment_terms: corrected } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await ready(ids.msa);
  assert.equal(after.contract.status, 'active'); assert.equal(after.contract.title, 'Nimbus MSA');
  const pay = after.fields.find((f) => f.field_name === 'payment_terms');
  assert.equal(pay.was_corrected, true); assert.equal(pay.value.amount, 4600); assert.equal(pay.extracted_value.amount, 4500);
  assert.equal(after.vendor.canonical_name, 'Nimbus Cloud Solutions Pvt Ltd');
});

await step('vendor entity resolution (manual): similar name prompts merge/create; merge → chronological vendor view', async () => {
  const r = await upload('nimbus-hosting-order-form-2024.pdf'); ids.old = r.data.id;
  const d = await ready(ids.old);
  const first = await api('POST', `/contracts/${ids.old}/confirm`, { body: confirmBody(d, 'Nimbus Cloud Solutions Private Limited') });
  assert.equal(first.status, 409); assert.equal(first.data.needs_vendor_decision, true);
  assert.equal(first.data.candidates[0].canonical_name, 'Nimbus Cloud Solutions Pvt Ltd');
  const merged = await api('POST', `/contracts/${ids.old}/confirm`, { body: confirmBody(d, 'Nimbus Cloud Solutions Private Limited', { vendor_decision: 'merge', merge_id: first.data.candidates[0].id }) });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  const vendors = (await api('GET', '/vendors')).data;
  assert.equal(vendors.length, 1); assert.equal(vendors[0].contract_count, 2);
  assert.ok(vendors[0].aliases.includes('Nimbus Cloud Solutions Private Limited'));
  const v = (await api('GET', `/vendors/${vendors[0].id}`)).data;
  assert.deepEqual(v.contracts.map((c) => c.title), ['Nimbus Hosting Order Form (2024)', 'Nimbus MSA'], 'oldest first');
  assert.equal((await ready(ids.old)).contract.status, 'expired', 'past expiry → expired');
});

await step('vendor entity resolution: "create new" keeps them separate', async () => {
  const r = await upload('spcb-consent-to-operate.pdf'); ids.spcb = r.data.id;
  const d = await ready(ids.spcb);
  const ok = await api('POST', `/contracts/${ids.spcb}/confirm`, { body: confirmBody(d, 'State Pollution Control Board') });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await api('GET', '/vendors')).data.length, 2);
});

await step('automatic vendor chain (customer): near-identical name auto-links without a prompt', async () => {
  await api('PUT', '/settings', { uid: 1, body: { vendor_mode: 'automatic' } });
  const a = await upload('sunrise-apartment-lease.pdf', 1); const da = await ready(a.data.id, 1);
  const b = await upload('sunrise-apartment-lease.pdf', 1, '?allow_duplicate=1'); const db = await ready(b.data.id, 1);
  assert.equal((await api('POST', `/contracts/${a.data.id}/confirm`, { uid: 1, body: confirmBody(da, 'Sunrise Properties LLP') })).status, 200);
  const r = await api('POST', `/contracts/${b.data.id}/confirm`, { uid: 1, body: confirmBody(db, 'Sunrise Properties') });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.auto_merged, 'auto_merged reported');
  assert.equal((await api('GET', '/vendors', { uid: 1 })).data.length, 1);
});

await step('tenancy: customer cannot see business contracts and vice versa', async () => {
  assert.equal((await api('GET', `/contracts/${ids.msa}`, { uid: 1 })).status, 404);
  assert.equal((await api('GET', '/contracts', { uid: 1 })).data.length, 2);
});

await step('teammate has FULL access to the same contracts: view, chat, upload, edit, delete', async () => {
  assert.equal((await api('GET', `/contracts/${ids.msa}`, { uid: 3 })).status, 200);
  assert.equal((await api('GET', '/contracts', { uid: 3 })).data.length, (await api('GET', '/contracts', { uid: 2 })).data.length);
  const c = await api('POST', `/contracts/${ids.msa}/chat`, { uid: 3, body: { question: 'When does this expire?' } });
  assert.equal(c.status, 200);
  const up = await upload('sunrise-apartment-lease.pdf', 3); assert.equal(up.status, 202);
  const d = await ready(up.data.id, 3);
  assert.equal((await api('POST', `/contracts/${up.data.id}/confirm`, { uid: 3, body: confirmBody(d, 'Sunrise Properties LLP') })).status, 200, 'teammate can confirm');
  assert.equal((await api('DELETE', `/contracts/${up.data.id}`, { uid: 3 })).status, 200, 'teammate can delete');
  assert.equal((await api('GET', `/contracts/${up.data.id}`, { uid: 2 })).status, 404);
  assert.equal((await api('GET', `/contracts/${ids.msa}`, { uid: 1 })).status, 404, 'individual cannot see the org');
});

await step('chat: answers cite real paragraphs; confidence is explicit; unknown topics say so', async () => {
  const a = (await api('POST', `/contracts/${ids.msa}/chat`, { body: { question: 'How much do I pay and when?' } })).data;
  assert.ok(a.citations.length > 0 && a.citations.every((c) => c.label && c.quote), 'has citations');
  assert.match(a.content, /4,600/, 'uses the user-corrected amount, not the original extraction');
  const low = (await api('POST', `/contracts/${ids.spcb}/chat`, { body: { question: 'How much is the annual consent fee?' } })).data;
  assert.equal(low.confidence, 'low'); assert.match(low.content, /not certain|not confident/i);
  const none = (await api('POST', `/contracts/${ids.msa}/chat`, { body: { question: 'zebra giraffe helicopter?' } })).data;
  assert.equal(none.confidence, 'low'); assert.match(none.content, /^I'm not certain/); assert.equal(none.citations.length, 0);
  const hist = (await api('GET', `/contracts/${ids.msa}/chat`)).data;
  assert.ok(hist.length >= 4 && hist.some((m) => m.role === 'assistant' && m.citations.length));
});

await step('expiry alerts: dashboard lists contracts inside the window, soonest first; active reminders fire once', async () => {
  const d1 = (await api('GET', '/dashboard')).data;
  const titles = d1.expiring.map((e) => e.title);
  assert.ok(titles.includes('Nimbus MSA') && titles.includes('SPCB Consent to Operate – Pune Unit'), titles.join(','));
  assert.deepEqual(d1.expiring.map((e) => e.days_left), [...d1.expiring.map((e) => e.days_left)].sort((a, b) => a - b));
  assert.equal(d1.expiring.find((e) => e.title === 'Nimbus MSA').window, 30);
  await api('POST', '/reminders/run');
  const n1 = (await api('GET', '/dashboard')).data.notifications.length;
  await api('POST', '/reminders/run');
  assert.equal((await api('GET', '/dashboard')).data.notifications.length, n1, 'no duplicate reminders');
  assert.ok(n1 >= 2);
  await api('PUT', '/settings', { body: { alert_windows: [10] } });
  assert.ok(!(await api('GET', '/dashboard')).data.expiring.some((e) => e.title === 'Nimbus MSA'), 'window is configurable');
  await api('PUT', '/settings', { body: { alert_windows: [30, 15, 7] } });
});

await step('regulatory-change demo (mock): maps seeded updates to regulatory_class contracts only', async () => {
  const r = (await api('GET', '/dashboard')).data.regulatory_changes;
  assert.equal(r.length, 1); assert.deepEqual(r[0].affected.map((a) => a.id), [ids.spcb]);
});

await step('original file is served back', async () => {
  const res = await fetch(`${BASE}/api/contracts/${ids.msa}/file`, { headers: { authorization: `Bearer ${tokens[2]}` } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
