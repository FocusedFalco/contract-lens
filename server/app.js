import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { q, one, tx, now, j, unj, getSetting, setSetting, ready } from './db.js';
import { ROOT, MODE, MODEL, PROVIDER, MAX_UPLOAD_BYTES } from './config.js';
import { extractContract, sha256, isSupportedMime, matchesMime, FIELD_NAMES } from './extract.js';
import { answerQuestion } from './chat.js';
import { matchVendors, createVendor, addAlias, AUTO_THRESHOLD } from './vendors.js';
import { expiringContracts, runReminders, refreshStatuses, daysUntil, alertWindows } from './alerts.js';
import { refLabel } from './pdf.js';
import { wrap, httpError } from './util.js';
import { limit, LIMITS } from './ratelimit.js';

const app = express();
// Exactly one trusted proxy hop (Vercel's edge): req.ip is the real client and a client-sent X-Forwarded-For can't spoof it.
app.set('trust proxy', 1);
app.disable('x-powered-by');

const GATE = process.env.ACCESS_PASSWORD || '';
const PUBLIC_HOST = !!process.env.VERCEL || process.env.NODE_ENV === 'production';
if (GATE && GATE.length < 12) console.warn('ACCESS_PASSWORD is shorter than 12 characters. Use a long random value.');

// ------------------------------------------------------------------ security headers
// style-src needs 'unsafe-inline' because the UI uses inline style attributes; there are no inline scripts.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // The original-file route is exempt from CSP: a strict policy can stop browsers' built-in PDF viewers from rendering.
  if (!/^\/api\/contracts\/\d+\/file$/.test(req.path)) res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Fail closed: on a public host an unset access code must never mean "everything is open".
if (PUBLIC_HOST && !GATE) {
  app.use('/api', (req, res) => res.status(503).json({ error: 'Server not configured: set ACCESS_PASSWORD (12+ random characters) in the environment.' }));
}

app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Cross-site request guard (defense in depth on top of SameSite cookies): a browser request that changes data must come from our own origin.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let same = false;
  try { same = new URL(origin).host === req.headers.host; } catch { /* "null" or malformed origin */ }
  same ? next() : next(httpError(403, 'Cross-origin request blocked.'));
});

// Make sure the database is reachable (and the schema exists) before any API work.
app.use('/api', async (req, res, next) => {
  try { await ready; next(); } catch (e) { console.error('database unavailable:', e.message); next(httpError(503, 'Database unavailable. Please try again shortly.')); }
});

// ------------------------------------------------------------------ optional access code
// There are no accounts. If ACCESS_PASSWORD is set (mandatory on a public host, see the guard above), the API refuses
// requests until the visitor enters that code once. The browser then keeps a signed cookie that expires after 7 days.
// Set SESSION_SECRET (32+ random bytes) so the cookie can never be used to brute-force the access code offline.
const SESSION_SECRET = process.env.SESSION_SECRET || GATE;
const sign = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
const cookieOf = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1] || '';
// Constant-time comparison that also hides the length (both sides are hashed with a throwaway key first).
const safeEq = (a, b) => { const k = crypto.randomBytes(32); const h = (s) => crypto.createHmac('sha256', k).update(String(s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
const secureFlag = (req) => (req.secure ? '; Secure' : '');
const issueToken = () => { const exp = Date.now() + 7 * 864e5; return `${exp}.${sign(`gate:${exp}`)}`; };
const validToken = (t) => { const [exp, sig] = String(t).split('.'); return Number(exp) > Date.now() && !!sig && safeEq(sig, sign(`gate:${exp}`)); };
const unlocked = (req) => !GATE || validToken(cookieOf(req, 'cl_gate'));

app.get('/api/gate', (req, res) => res.json({ required: !!GATE, unlocked: unlocked(req) }));
app.post('/api/unlock', wrap(async (req, res) => {
  if (!GATE) return res.json({ ok: true });
  await limit(`unlock:${req.ip}`, LIMITS.unlock.max, LIMITS.unlock.windowMs); // shared across serverless instances
  if (!safeEq(req.body?.code ?? '', GATE)) throw httpError(401, 'Wrong access code.');
  res.append('Set-Cookie', `cl_gate=${issueToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureFlag(req)}`);
  res.json({ ok: true });
}));
// "Sign out": clears the access-code cookie so this browser is asked for the code again (useful on a shared computer).
app.post('/api/lock', (req, res) => {
  res.append('Set-Cookie', `cl_gate=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag(req)}`);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => (unlocked(req) ? next() : next(httpError(401, 'Access code required.', { gate: true }))));

// ------------------------------------------------------------------ single open workspace
const WORKSPACE = { user: { id: 1, name: 'You' }, ownerKey: 'workspace:1', ownerName: 'the person who uploaded this contract (name not provided)' };
// Chat history belongs to a browser session (random cookie), so people sharing the workspace can't read or wipe each other's questions.
app.use('/api', (req, res, next) => {
  let sid = cookieOf(req, 'cl_sid');
  if (!/^[A-Za-z0-9_-]{22}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('base64url');
    res.append('Set-Cookie', `cl_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secureFlag(req)}`);
  }
  req.ctx = { ...WORKSPACE, sid };
  next();
});

const vendorMode = (ctx) => getSetting(`vendor_mode:user:${ctx.user.id}`, 'manual');

app.get('/api/session', wrap(async (req, res) => {
  res.json({ mode: MODE, provider: MODE === 'live' ? PROVIDER : null, model: MODE === 'live' ? MODEL : null, gated: !!GATE, settings: { vendor_mode: await vendorMode(req.ctx), alert_windows: await alertWindows(req.ctx.ownerKey) } });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const { vendor_mode, alert_windows } = req.body || {};
  if (vendor_mode !== undefined) {
    if (!['manual', 'automatic'].includes(vendor_mode)) throw httpError(400, 'vendor_mode must be manual or automatic');
    await setSetting(`vendor_mode:user:${req.ctx.user.id}`, vendor_mode);
  }
  if (alert_windows !== undefined) {
    const w = [...new Set((alert_windows || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0 && n <= 365).sort((a, b) => a - b);
    if (!w.length) throw httpError(400, 'Provide at least one window in days (1–365).');
    await setSetting(`alert_windows:${req.ctx.ownerKey}`, w);
  }
  res.json({ vendor_mode: await vendorMode(req.ctx), alert_windows: await alertWindows(req.ctx.ownerKey) });
}));

// ------------------------------------------------------------------ helpers for contracts
const CONTRACT_COLS = `id, owner_key, vendor_id, title, contract_type, file_name, file_mime, file_sha, uploaded_by, uploaded_at,
  effective_date, expiration_date, summary_text, status, extraction_mode, error, doc_quality, suggested_vendor, reviewed_by, reviewed_at`;
const ownContract = async (req, id) => {
  const c = await one(`SELECT ${CONTRACT_COLS} FROM contract WHERE id = ? AND owner_key = ?`, [Number(id) || 0, req.ctx.ownerKey]);
  if (!c) throw httpError(404, 'Contract not found');
  return c;
};
const LEVEL_ORDER = { low: 0, medium: 1, high: 2 };

async function loadFields(contractId, run = q) {
  return (await run('SELECT * FROM contract_field WHERE contract_id = ?', [contractId]))
    .map((f) => {
      const extracted = unj(f.extracted_value);
      const corrected = f.corrected_value === null ? undefined : unj(f.corrected_value);
      return {
        field_name: f.field_name, extracted_value: extracted, corrected_value: corrected ?? null, was_corrected: f.corrected_value !== null,
        value: f.corrected_value !== null ? corrected : extracted, confidence: f.confidence, source_refs: unj(f.source_refs) || [], rationale: f.rationale,
      };
    })
    .sort((a, b) => LEVEL_ORDER[a.confidence] - LEVEL_ORDER[b.confidence] || FIELD_NAMES.indexOf(a.field_name) - FIELD_NAMES.indexOf(b.field_name));
}

const loadParagraphs = (id) => q('SELECT id, page, clause, text FROM paragraph WHERE contract_id = ? ORDER BY seq', [id]);

async function loadFlags(id, paragraphs) {
  const byId = Object.fromEntries(paragraphs.map((p) => [p.id, p]));
  return (await q('SELECT * FROM clause_flag WHERE contract_id = ? ORDER BY id', [id])).map((f) => ({
    ...f, resolved: !!f.resolved,
    source: f.source_ref && byId[f.source_ref] ? { id: f.source_ref, label: refLabel(byId[f.source_ref]), text: byId[f.source_ref].text } : null,
  }));
}

async function regulatoryMatches(ownerKey, onlyContractId = null) {
  const [regs, contracts] = await Promise.all([
    q('SELECT * FROM regulation_update ORDER BY published DESC'),
    q("SELECT id, title FROM contract WHERE owner_key = ? AND contract_type = 'regulatory_class' AND status IN ('active','expired','pending_review')", [ownerKey]),
  ]);
  const wanted = contracts.filter((c) => onlyContractId == null || c.id === onlyContractId);
  if (!regs.length || !wanted.length) return [];
  // One query for every contract's text, not one round trip per contract.
  const rows = await q(`SELECT contract_id, string_agg(text, ' ') AS t FROM paragraph WHERE contract_id IN (${wanted.map(() => '?').join(',')}) GROUP BY contract_id`, wanted.map((c) => c.id));
  const texts = Object.fromEntries(rows.map((r) => [r.contract_id, (r.t || '').toLowerCase()]));
  const contractsForMap = wanted;
  return regs.map((r) => {
    const kws = unj(r.keywords);
    const affected = contractsForMap.map((c) => {
      const matched = kws.filter((k) => (texts[c.id] || '').includes(k));
      return matched.length ? { id: c.id, title: c.title, matched_keywords: matched } : null;
    }).filter(Boolean);
    return { id: r.id, title: r.title, authority: r.authority, summary: r.summary, published: r.published, effective: r.effective, affected };
  }).filter((r) => r.affected.length);
}

// ------------------------------------------------------------------ upload + extraction pipeline
// Runs inside the upload request: serverless hosts stop work once the response is sent.
async function processContract(id, { buffer, mime, fileName, ownerName }) {
  try {
    const ex = await extractContract({ buffer, mime, fileName, ownerName });
    const effective = (n) => ex.fields[n].value;
    await tx(async (t) => {
      for (const p of ex.paragraphs) await t.q('INSERT INTO paragraph (contract_id, id, page, clause, text) VALUES (?,?,?,?,?)', [id, p.id, p.page, p.clause, p.text]);
      for (const [name, f] of Object.entries(ex.fields)) await t.q('INSERT INTO contract_field (contract_id, field_name, extracted_value, confidence, source_refs, rationale) VALUES (?,?,?,?,?,?)', [id, name, j(f.value), f.confidence, j(f.source_refs), f.rationale]);
      for (const f of ex.flags) await t.q('INSERT INTO clause_flag (contract_id, flag_type, description, source_ref) VALUES (?,?,?,?)', [id, f.flag_type, f.description, f.source_ref]);
      await t.q(`UPDATE contract SET status = 'pending_review', title = ?, contract_type = ?, summary_text = ?, doc_quality = ?, suggested_vendor = ?,
        extraction_mode = ?, effective_date = ?, expiration_date = ?, error = NULL WHERE id = ?`,
      [ex.title || fileName, ex.contract_type, ex.summary, ex.doc_quality, ex.vendor_name, ex.mode, effective('effective_date'), effective('expiration_date'), id]);
    });
  } catch (e) {
    console.error(`extraction failed for contract ${id}:`, e.message);
    await q("UPDATE contract SET status = 'failed', error = ? WHERE id = ?", [String(e.message).slice(0, 300), id]);
  }
}

// Each upload triggers paid AI calls, so it is rate limited per client, and before multer buffers the body in memory.
const uploadGuard = wrap(async (req, res, next) => { await limit(`upload:${req.ip}`, LIMITS.upload.max, LIMITS.upload.windowMs); next(); });
app.post('/api/contracts', uploadGuard, upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) throw httpError(400, 'Attach a file in the "file" field.');
  f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer hands filenames over as latin1 (an em dash would arrive garbled)
  const ext = path.extname(f.originalname).toLowerCase();
  const mime = f.mimetype !== 'application/octet-stream' ? f.mimetype : ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[ext];
  if (!isSupportedMime(mime)) throw httpError(415, 'Unsupported file type. Upload a PDF, PNG, JPG or WebP.');
  // The declared type is client-controlled: confirm the bytes really are that kind of file.
  if (!matchesMime(f.buffer, mime)) throw httpError(415, 'The file content does not match its type. Is it really a PDF or image?');
  const sha = sha256(f.buffer);
  const dupe = await one("SELECT id, title FROM contract WHERE owner_key = ? AND file_sha = ? AND status != 'failed'", [req.ctx.ownerKey, sha]);
  if (dupe && !req.query.allow_duplicate) throw httpError(409, `This exact file is already stored as "${dupe.title}".`, { duplicate_of: dupe.id });

  const safe = f.originalname.replace(/[^\w.\- ]+/g, '_');
  const { id } = await one(`INSERT INTO contract (owner_key, title, file_name, file_data, file_mime, file_sha, uploaded_by, uploaded_at, status)
    VALUES (?,?,?,?,?,?,?,?, 'processing') RETURNING id`, [req.ctx.ownerKey, safe, f.originalname, f.buffer, mime, sha, req.ctx.user.id, now()]);
  await processContract(id, { buffer: f.buffer, mime, fileName: f.originalname, ownerName: req.ctx.ownerName });
  res.status(202).json({ id });
}));

// ------------------------------------------------------------------ contracts
app.get('/api/contracts', wrap(async (req, res) => {
  await refreshStatuses();
  const rows = await q(`
    SELECT c.id, c.title, c.contract_type, c.status, c.file_name, c.uploaded_at, c.effective_date, c.expiration_date, c.error,
      c.vendor_id, v.canonical_name AS vendor_name,
      (SELECT COUNT(*) FROM clause_flag f WHERE f.contract_id = c.id AND f.resolved = 0)::int AS open_flags,
      (SELECT COUNT(*) FROM contract_field cf WHERE cf.contract_id = c.id AND cf.confidence = 'low')::int AS low_fields
    FROM contract c LEFT JOIN vendor v ON v.id = c.vendor_id
    WHERE c.owner_key = ? ORDER BY c.uploaded_at DESC`, [req.ctx.ownerKey]);
  res.json(rows.map((r) => ({ ...r, days_left: r.status === 'active' || r.status === 'expired' ? daysUntil(r.expiration_date) : null })));
}));

app.get('/api/contracts/:id', wrap(async (req, res) => {
  await refreshStatuses();
  const c = await ownContract(req, req.params.id);
  const [paragraphs, vendor, fields, vmode, regulatory_alerts] = await Promise.all([
    loadParagraphs(c.id),
    c.vendor_id ? one('SELECT id, canonical_name FROM vendor WHERE id = ?', [c.vendor_id]) : null,
    loadFields(c.id),
    vendorMode(req.ctx),
    regulatoryMatches(req.ctx.ownerKey, c.id),
  ]);
  const lookup = vendor?.canonical_name || c.suggested_vendor || '';
  const [flags, vendor_candidates] = await Promise.all([loadFlags(c.id, paragraphs), lookup ? matchVendors(req.ctx.ownerKey, lookup, 0.5) : []]);
  res.json({
    contract: { ...c, days_left: daysUntil(c.expiration_date) }, vendor, vendor_candidates,
    vendor_mode: vmode, auto_threshold: AUTO_THRESHOLD, fields, flags, paragraphs, regulatory_alerts,
  });
}));

app.get('/api/contracts/:id/file', wrap(async (req, res) => {
  const f = await one('SELECT file_name, file_mime, file_data FROM contract WHERE id = ? AND owner_key = ?', [Number(req.params.id) || 0, req.ctx.ownerKey]);
  if (!f?.file_data) throw httpError(404, 'File not found');
  res.setHeader('Content-Type', f.file_mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.file_name)}"`);
  res.send(Buffer.from(f.file_data));
}));

app.delete('/api/contracts/:id', wrap(async (req, res) => {
  const c = await ownContract(req, req.params.id);
  await q('DELETE FROM contract WHERE id = ?', [c.id]);
  res.json({ ok: true });
}));

const REVIEW_ALWAYS = new Set(['expiration_date', 'payment_terms']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function validateFieldValue(name, v) {
  if (JSON.stringify(v ?? null).length > 20000) throw httpError(422, `${name.replace(/_/g, ' ')} is too large.`);
  if (name === 'effective_date' || name === 'expiration_date') {
    if (v !== null && !(typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)))) throw httpError(422, `${name.replace('_', ' ')} must be a date (YYYY-MM-DD) or empty.`);
  } else if (name === 'payment_terms') {
    if (v !== null && (typeof v !== 'object' || !['one-time', 'monthly', 'quarterly', 'annual', 'other', 'unknown'].includes(v.recurrence))) throw httpError(422, 'Payment recurrence must be one-time, monthly, quarterly or annual.');
    if (v && v.amount !== null && !Number.isFinite(Number(v.amount))) throw httpError(422, 'Payment amount must be a number.');
  } else if (name === 'parties' || name === 'service_obligations') {
    if (!Array.isArray(v)) throw httpError(422, `${name} must be a list.`);
  }
}

app.post('/api/contracts/:id/confirm', wrap(async (req, res) => {
  const { ownerKey } = req.ctx;
  const c = await ownContract(req, req.params.id);
  if (!['pending_review', 'active', 'expired'].includes(c.status)) throw httpError(409, `A contract in status "${c.status}" cannot be confirmed.`);
  const b = req.body || {};
  const firstReview = c.status === 'pending_review';

  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) throw httpError(422, 'Give the contract a name.');
  if (!['business_class', 'regulatory_class'].includes(b.contract_type)) throw httpError(422, 'Choose a contract type.');

  const fields = await loadFields(c.id);
  const edits = b.fields || {};
  for (const [name, v] of Object.entries(edits)) {
    if (!FIELD_NAMES.includes(name)) throw httpError(422, `Unknown field ${name}`);
    validateFieldValue(name, v);
  }

  // Mandatory human review: every non-high-confidence field and every flag must be acknowledged (or edited).
  if (firstReview) {
    const ackF = new Set(b.acknowledged_fields || []);
    const ackFl = new Set((b.acknowledged_flags || []).map(Number));
    const changed = (f) => f.field_name in edits && !sameJson(edits[f.field_name], f.extracted_value);
    // Confidence is self-reported by the model, so a manipulated or mistaken "high" must not skip review for the two
    // fields with real-world consequences (keep this rule in sync with needsAck() in public/app.js).
    const needsAck = (f) => f.confidence !== 'high' || REVIEW_ALWAYS.has(f.field_name);
    const missingFields = fields.filter((f) => needsAck(f) && !ackF.has(f.field_name) && !changed(f)).map((f) => f.field_name);
    const missingFlags = (await q('SELECT id FROM clause_flag WHERE contract_id = ?', [c.id])).map((f) => f.id).filter((id) => !ackFl.has(id));
    if (missingFields.length || missingFlags.length) {
      throw httpError(422, 'Review every low/medium-confidence field and every flagged clause before confirming.', { missing_fields: missingFields, missing_flags: missingFlags });
    }
  }

  // Vendor resolution (basic entity resolution; manual vs automatic vendor chain). Decide first, write inside the transaction.
  const mode = await vendorMode(req.ctx);
  const v = b.vendor || {};
  let plan, autoMerged = null;
  const vendorRow = async (id) => {
    const row = await one('SELECT id, canonical_name FROM vendor WHERE id = ? AND owner_key = ?', [Number(id) || 0, ownerKey]);
    if (!row) throw httpError(422, 'That vendor does not exist.');
    return row;
  };
  if (v.id) {
    const row = await vendorRow(v.id);
    const alias = String(v.name || '').trim().slice(0, 200);
    plan = { id: row.id, alias: alias && alias !== row.canonical_name ? alias : null };
  } else {
    const name = String(v.name || '').trim().slice(0, 200);
    if (!name) throw httpError(422, 'Choose or enter a vendor.');
    const existing = await one('SELECT id FROM vendor WHERE owner_key = ? AND lower(canonical_name) = lower(?)', [ownerKey, name]);
    const candidates = await matchVendors(ownerKey, name);
    if (existing) plan = { id: existing.id };
    else if (b.vendor_decision === 'new') plan = { create: name };
    else if (b.vendor_decision === 'merge' && b.merge_id) plan = { id: (await vendorRow(b.merge_id)).id, alias: name };
    else if (candidates.length && mode === 'automatic' && candidates[0].score >= AUTO_THRESHOLD) {
      plan = { id: candidates[0].id, alias: name };
      autoMerged = { id: candidates[0].id, name: candidates[0].canonical_name, score: candidates[0].score };
    } else if (candidates.length) {
      throw httpError(409, 'Similar vendors already exist.', { needs_vendor_decision: true, entered: name, candidates });
    } else plan = { create: name };
  }

  const vendorId = await tx(async (t) => {
    const vid = plan.create ? await createVendor(ownerKey, plan.create, t) : plan.id;
    if (plan.alias) await addAlias(vid, plan.alias, t);
    for (const f of fields) {
      if (!(f.field_name in edits)) continue;
      await t.q('UPDATE contract_field SET corrected_value = ? WHERE contract_id = ? AND field_name = ?', [sameJson(edits[f.field_name], f.extracted_value) ? null : j(edits[f.field_name]), c.id, f.field_name]);
    }
    const eff = await loadFields(c.id, t.q);
    const val = (n) => eff.find((f) => f.field_name === n).value;
    const expiry = val('expiration_date');
    const status = expiry && daysUntil(expiry) < 0 ? 'expired' : 'active';
    await t.q(`UPDATE contract SET title = ?, contract_type = ?, vendor_id = ?, summary_text = ?, effective_date = ?, expiration_date = ?, status = ?,
      reviewed_by = COALESCE(?::int, reviewed_by), reviewed_at = COALESCE(?::text, reviewed_at) WHERE id = ?`,
    [title, b.contract_type, vid, typeof b.summary_text === 'string' ? b.summary_text.slice(0, 5000) : c.summary_text, val('effective_date'), expiry, status,
      firstReview ? req.ctx.user.id : null, firstReview ? now() : null, c.id]);
    for (const [id, resolved] of Object.entries(b.flag_resolved || {})) await t.q('UPDATE clause_flag SET resolved = ? WHERE id = ? AND contract_id = ?', [resolved ? 1 : 0, Number(id), c.id]);
    return vid;
  });
  const vendor = await one('SELECT id, canonical_name FROM vendor WHERE id = ?', [vendorId]);
  await runReminders(); // a newly active contract may already be inside an alert window
  res.json({ ok: true, id: c.id, vendor, auto_merged: autoMerged });
}));

// ------------------------------------------------------------------ chat (single contract)
// cited_sources stores {citations, web_citations}; a plain array means an older row from before web_citations existed.
const unpackSources = (raw) => { const v = unj(raw); return Array.isArray(v) ? { citations: v, web_citations: [] } : { citations: v?.citations || [], web_citations: v?.web_citations || [] }; };

app.get('/api/contracts/:id/chat', wrap(async (req, res) => {
  const c = await ownContract(req, req.params.id);
  const rows = await q('SELECT * FROM chat_message WHERE contract_id = ? AND session_id = ? ORDER BY id', [c.id, req.ctx.sid]);
  res.json(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, ...unpackSources(m.cited_sources), confidence: m.confidence, created_at: m.created_at })));
}));

app.post('/api/contracts/:id/chat', wrap(async (req, res) => {
  await limit(`chat:${req.ip}`, LIMITS.chat.max, LIMITS.chat.windowMs); // every answer is a paid AI call
  const c = await ownContract(req, req.params.id);
  if (['processing', 'failed'].includes(c.status)) throw httpError(409, 'This contract has no readable text to ask about.');
  const question = String(req.body?.question || '').trim();
  if (!question) throw httpError(400, 'Ask a question.');
  if (question.length > 2000) throw httpError(400, 'Question is too long (2000 characters max).');
  const paragraphs = await loadParagraphs(c.id);
  // Only the last 6 messages of THIS browser session are ever replayed to the model (newest first, then put back in order).
  const history = (await q('SELECT role, content FROM chat_message WHERE contract_id = ? AND session_id = ? ORDER BY id DESC LIMIT 6', [c.id, req.ctx.sid])).reverse();
  const fields = (await loadFields(c.id)).map((f) => ({ field_name: f.field_name, value: f.value, confidence: f.confidence, corrected: f.was_corrected, source_refs: f.source_refs, rationale: f.rationale }));
  const flags = await loadFlags(c.id, paragraphs);
  let out;
  try {
    out = await answerQuestion({ question, paragraphs, fields, flags, history });
  } catch (e) {
    console.error('chat answer failed:', e.message); // the upstream error text stays in the server log, not in the response
    throw httpError(502, e.status === 429 ? 'The AI service is busy right now. Please try again in a minute.' : 'The AI service could not answer right now. Please try again.');
  }
  const ins = 'INSERT INTO chat_message (contract_id, user_id, role, content, cited_sources, confidence, created_at, session_id) VALUES (?,?,?,?,?,?,?,?)';
  await q(ins, [c.id, req.ctx.user.id, 'user', question, '[]', null, now(), req.ctx.sid]);
  await q(ins, [c.id, req.ctx.user.id, 'assistant', out.answer, j({ citations: out.citations, web_citations: out.web_citations }), out.confidence, now(), req.ctx.sid]);
  res.json({ role: 'assistant', content: out.answer, citations: out.citations, web_citations: out.web_citations, confidence: out.confidence, mode: out.mode });
}));

app.delete('/api/contracts/:id/chat', wrap(async (req, res) => {
  const c = await ownContract(req, req.params.id);
  await q('DELETE FROM chat_message WHERE contract_id = ? AND session_id = ?', [c.id, req.ctx.sid]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ vendors
app.get('/api/vendors', wrap(async (req, res) => {
  await refreshStatuses();
  const rows = await q(`
    SELECT v.id, v.canonical_name, v.aliases, COUNT(c.id)::int AS contract_count,
      COALESCE(SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_count,
      MIN(CASE WHEN c.status = 'active' THEN c.expiration_date END) AS next_expiry
    FROM vendor v LEFT JOIN contract c ON c.vendor_id = v.id AND c.status IN ('active','expired','archived')
    WHERE v.owner_key = ? GROUP BY v.id ORDER BY lower(v.canonical_name)`, [req.ctx.ownerKey]);
  res.json(rows.map((r) => ({ ...r, aliases: unj(r.aliases) || [], next_expiry_days: daysUntil(r.next_expiry) })));
}));

app.get('/api/vendors/:id', wrap(async (req, res) => {
  await refreshStatuses();
  const v = await one('SELECT * FROM vendor WHERE id = ? AND owner_key = ?', [Number(req.params.id) || 0, req.ctx.ownerKey]);
  if (!v) throw httpError(404, 'Vendor not found');
  const contracts = await q(`
    SELECT id, title, contract_type, status, effective_date, expiration_date, uploaded_at, summary_text,
      (SELECT COUNT(*) FROM clause_flag f WHERE f.contract_id = contract.id AND f.resolved = 0)::int AS open_flags
    FROM contract WHERE vendor_id = ? AND owner_key = ? AND status IN ('active','expired','archived')
    ORDER BY COALESCE(effective_date, substr(uploaded_at, 1, 10)) ASC`, [v.id, req.ctx.ownerKey]);
  const pay = await q("SELECT contract_id, COALESCE(corrected_value, extracted_value) AS v FROM contract_field WHERE field_name = 'payment_terms' AND contract_id IN (SELECT id FROM contract WHERE vendor_id = ?)", [v.id]);
  const payBy = Object.fromEntries(pay.map((p) => [p.contract_id, unj(p.v)]));
  res.json({
    id: v.id, canonical_name: v.canonical_name, aliases: unj(v.aliases) || [],
    contracts: contracts.map((c) => ({ ...c, days_left: daysUntil(c.expiration_date), payment_terms: payBy[c.id] || null })),
  });
}));

app.patch('/api/vendors/:id', wrap(async (req, res) => {
  const v = await one('SELECT id, canonical_name FROM vendor WHERE id = ? AND owner_key = ?', [Number(req.params.id) || 0, req.ctx.ownerKey]);
  if (!v) throw httpError(404, 'Vendor not found');
  const name = typeof req.body?.name === 'string' ? req.body.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : '';
  if (!name) throw httpError(422, 'Enter a contractor name.');
  const dup = await one('SELECT id FROM vendor WHERE owner_key = ? AND lower(canonical_name) = lower(?) AND id <> ?', [req.ctx.ownerKey, name, v.id]);
  if (dup) throw httpError(409, 'Another contractor already has that name.');
  await tx(async (t) => {
    await t.q('UPDATE vendor SET canonical_name = ? WHERE id = ?', [name, v.id]);
    await addAlias(v.id, v.canonical_name, t); // keep the old spelling so future matches still link here
  });
  res.json({ ok: true, canonical_name: name });
}));

app.delete('/api/vendors/:id', wrap(async (req, res) => {
  const v = await one('SELECT id FROM vendor WHERE id = ? AND owner_key = ?', [Number(req.params.id) || 0, req.ctx.ownerKey]);
  if (!v) throw httpError(404, 'Vendor not found');
  const removed = await tx(async (t) => {
    const gone = await t.q('DELETE FROM contract WHERE vendor_id = ? AND owner_key = ? RETURNING id', [v.id, req.ctx.ownerKey]);
    await t.q('DELETE FROM vendor WHERE id = ?', [v.id]);
    return gone.length;
  });
  res.json({ ok: true, contracts_removed: removed });
}));

// ------------------------------------------------------------------ dashboard / reminders
app.get('/api/dashboard', wrap(async (req, res) => {
  const { ownerKey } = req.ctx;
  await runReminders(); // serverless hosts have no background timer, so reminders are also checked on load; also refreshes statuses
  const [countRows, expiring, pending, notifications, windows, regulatory_changes] = await Promise.all([
    q('SELECT status, COUNT(*)::int AS n FROM contract WHERE owner_key = ? GROUP BY status', [ownerKey]),
    expiringContracts(ownerKey, { skipRefresh: true }),
    q("SELECT id, title, uploaded_at FROM contract WHERE owner_key = ? AND status = 'pending_review' ORDER BY uploaded_at DESC", [ownerKey]),
    q('SELECT id, contract_id, message, window_days, created_at, read FROM notification WHERE owner_key = ? ORDER BY id DESC LIMIT 20', [ownerKey]),
    alertWindows(ownerKey), regulatoryMatches(ownerKey),
  ]);
  res.json({ expiring, counts: Object.fromEntries(countRows.map((r) => [r.status, r.n])), pending, notifications, windows, regulatory_changes });
}));

app.post('/api/reminders/run', wrap(async (req, res) => {
  await limit(`reminders:${req.ip}`, 30, 3600 * 1000);
  const created = await runReminders();
  res.json({ created: created.filter((c) => c.ownerKey === req.ctx.ownerKey).length });
}));
app.post('/api/notifications/:id/read', wrap(async (req, res) => {
  await q('UPDATE notification SET read = 1 WHERE id = ? AND owner_key = ?', [Number(req.params.id) || 0, req.ctx.ownerKey]);
  res.json({ ok: true });
}));
app.post('/api/notifications/read-all', wrap(async (req, res) => {
  await q('UPDATE notification SET read = 1 WHERE owner_key = ?', [req.ctx.ownerKey]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ static (local; Vercel serves /public itself) + errors
app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (25 MB max).' : 'Upload rejected.' });
  const status = err.status || 500;
  if (status === 500) {
    // Unexpected failure: the details (SQL, hosts, library messages) go to the server log only; the client gets a reference.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[${ref}] ${err.message}`);
    return res.status(500).json({ error: `Something went wrong on our side (ref ${ref}).` });
  }
  res.status(status).json({ error: err.message, ...(err.extra || {}) }); // 4xx/502/503 messages are written by us, never raw upstream text
});

export default app;
