import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { db, tx, now, j, unj, getSetting, setSetting } from './db.js';
import { PORT, ROOT, UPLOAD_DIR, MODE, MODEL, MAX_UPLOAD_BYTES, DEFAULT_ALERT_WINDOWS } from './config.js';
import { extractContract, sha256, isSupportedMime, FIELD_NAMES } from './extract.js';
import { answerQuestion } from './chat.js';
import { matchVendors, createVendor, addAlias, AUTO_THRESHOLD } from './vendors.js';
import { expiringContracts, runReminders, refreshStatuses, daysUntil, alertWindows } from './alerts.js';
import { refLabel } from './pdf.js';
import { registerAuthRoutes, requireUser } from './auth.js';
import { wrap, httpError } from './util.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// ------------------------------------------------------------------ auth: public routes first, then everything under /api requires a session
registerAuthRoutes(app);
app.use('/api', requireUser);

const vendorMode = (ctx) => getSetting(`vendor_mode:user:${ctx.user.id}`, 'manual');

// ------------------------------------------------------------------ session / settings
app.get('/api/session', (req, res) => {
  const { user, org, ownerKey } = req.ctx;
  const { id, name, email, phone, country, job_title, account_type } = user;
  res.json({
    user: { id, name, email, phone, country, job_title, account_type }, orgName: org?.name || null, mode: MODE, model: MODE === 'live' ? MODEL : null,
    settings: { vendor_mode: vendorMode(req.ctx), alert_windows: alertWindows(ownerKey) },
  });
});

// Team: everyone in an organisation has identical access; the invite code lets colleagues join at sign-up.
app.get('/api/org', (req, res) => {
  const { org } = req.ctx;
  if (!org) return res.json(null);
  const members = db.prepare(`SELECT u.name, u.email, u.job_title FROM org_member m JOIN user u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.joined_at`).all(org.id);
  res.json({ name: org.name, industry: org.industry, invite_code: org.invite_code, members });
});

app.put('/api/settings', (req, res) => {
  const { vendor_mode, alert_windows } = req.body || {};
  if (vendor_mode !== undefined) {
    if (!['manual', 'automatic'].includes(vendor_mode)) throw httpError(400, 'vendor_mode must be manual or automatic');
    setSetting(`vendor_mode:user:${req.ctx.user.id}`, vendor_mode);
  }
  if (alert_windows !== undefined) {
    const w = [...new Set((alert_windows || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0 && n <= 365).sort((a, b) => a - b);
    if (!w.length) throw httpError(400, 'Provide at least one window in days (1–365).');
    setSetting(`alert_windows:${req.ctx.ownerKey}`, w);
  }
  res.json({ vendor_mode: vendorMode(req.ctx), alert_windows: alertWindows(req.ctx.ownerKey) });
});

// ------------------------------------------------------------------ helpers for contracts
const ownContract = (req, id) => {
  const c = db.prepare('SELECT * FROM contract WHERE id = ? AND owner_key = ?').get(Number(id), req.ctx.ownerKey);
  if (!c) throw httpError(404, 'Contract not found');
  return c;
};
const LEVEL_ORDER = { low: 0, medium: 1, high: 2 };

function loadFields(contractId) {
  return db.prepare('SELECT * FROM contract_field WHERE contract_id = ?').all(contractId)
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

const loadParagraphs = (id) => db.prepare('SELECT id, page, clause, text FROM paragraph WHERE contract_id = ? ORDER BY rowid').all(id);

function loadFlags(id, paragraphs) {
  const byId = Object.fromEntries(paragraphs.map((p) => [p.id, p]));
  return db.prepare('SELECT * FROM clause_flag WHERE contract_id = ? ORDER BY id').all(id).map((f) => ({
    ...f, resolved: !!f.resolved,
    source: f.source_ref && byId[f.source_ref] ? { id: f.source_ref, label: refLabel(byId[f.source_ref]), text: byId[f.source_ref].text } : null,
  }));
}

function regulatoryMatches(ownerKey, onlyContractId = null) {
  const regs = db.prepare('SELECT * FROM regulation_update ORDER BY published DESC').all();
  const contracts = db.prepare("SELECT id, title FROM contract WHERE owner_key = ? AND contract_type = 'regulatory_class' AND status IN ('active','expired','pending_review')").all(ownerKey)
    .filter((c) => onlyContractId == null || c.id === onlyContractId);
  return regs.map((r) => {
    const kws = unj(r.keywords);
    const affected = contracts.map((c) => {
      const text = db.prepare(`SELECT group_concat(text, ' ') AS t FROM paragraph WHERE contract_id = ?`).get(c.id).t?.toLowerCase() || '';
      const matched = kws.filter((k) => text.includes(k));
      return matched.length ? { id: c.id, title: c.title, matched_keywords: matched } : null;
    }).filter(Boolean);
    return { id: r.id, title: r.title, authority: r.authority, summary: r.summary, published: r.published, effective: r.effective, affected };
  }).filter((r) => r.affected.length);
}

// ------------------------------------------------------------------ upload + extraction pipeline
async function processContract(id, { buffer, mime, fileName, ownerName }) {
  try {
    const ex = await extractContract({ buffer, mime, fileName, ownerName });
    const effective = (n) => ex.fields[n].value;
    tx(() => {
      const insP = db.prepare('INSERT INTO paragraph (contract_id, id, page, clause, text) VALUES (?,?,?,?,?)');
      ex.paragraphs.forEach((p) => insP.run(id, p.id, p.page, p.clause, p.text));
      const insF = db.prepare('INSERT INTO contract_field (contract_id, field_name, extracted_value, confidence, source_refs, rationale) VALUES (?,?,?,?,?,?)');
      for (const [name, f] of Object.entries(ex.fields)) insF.run(id, name, j(f.value), f.confidence, j(f.source_refs), f.rationale);
      const insFl = db.prepare('INSERT INTO clause_flag (contract_id, flag_type, description, source_ref) VALUES (?,?,?,?)');
      ex.flags.forEach((f) => insFl.run(id, f.flag_type, f.description, f.source_ref));
      db.prepare(`UPDATE contract SET status = 'pending_review', title = ?, contract_type = ?, summary_text = ?, doc_quality = ?, suggested_vendor = ?,
        extraction_mode = ?, effective_date = ?, expiration_date = ?, error = NULL WHERE id = ?`)
        .run(ex.title || fileName, ex.contract_type, ex.summary, ex.doc_quality, ex.vendor_name, ex.mode, effective('effective_date'), effective('expiration_date'), id);
    });
  } catch (e) {
    console.error(`extraction failed for contract ${id}:`, e.message);
    db.prepare("UPDATE contract SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
  }
}

app.post('/api/contracts', upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) throw httpError(400, 'Attach a file in the "file" field.');
  const ext = path.extname(f.originalname).toLowerCase();
  const mime = f.mimetype !== 'application/octet-stream' ? f.mimetype : ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[ext];
  if (!isSupportedMime(mime)) throw httpError(415, 'Unsupported file type. Upload a PDF, PNG, JPG or WebP.');
  const sha = sha256(f.buffer);
  const dupe = db.prepare("SELECT id, title FROM contract WHERE owner_key = ? AND file_sha = ? AND status != 'failed'").get(req.ctx.ownerKey, sha);
  if (dupe && !req.query.allow_duplicate) throw httpError(409, `This exact file is already stored as "${dupe.title}".`, { duplicate_of: dupe.id });

  const safe = f.originalname.replace(/[^\w.\- ]+/g, '_');
  const stored = `${crypto.randomUUID()}-${safe}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.buffer);
  const r = db.prepare(`INSERT INTO contract (owner_key, title, file_name, file_path, file_mime, file_sha, uploaded_by, uploaded_at, status)
    VALUES (?,?,?,?,?,?,?,?, 'processing')`).run(req.ctx.ownerKey, safe, f.originalname, stored, mime, sha, req.ctx.user.id, now());
  const id = Number(r.lastInsertRowid);
  processContract(id, { buffer: f.buffer, mime, fileName: f.originalname, ownerName: req.ctx.ownerName }); // async; client polls
  res.status(202).json({ id });
}));

// ------------------------------------------------------------------ contracts
app.get('/api/contracts', (req, res) => {
  refreshStatuses();
  const rows = db.prepare(`
    SELECT c.id, c.title, c.contract_type, c.status, c.file_name, c.uploaded_at, c.effective_date, c.expiration_date, c.error,
      c.vendor_id, v.canonical_name AS vendor_name,
      (SELECT COUNT(*) FROM clause_flag f WHERE f.contract_id = c.id AND f.resolved = 0) AS open_flags,
      (SELECT COUNT(*) FROM contract_field cf WHERE cf.contract_id = c.id AND cf.confidence = 'low') AS low_fields
    FROM contract c LEFT JOIN vendor v ON v.id = c.vendor_id
    WHERE c.owner_key = ? ORDER BY c.uploaded_at DESC`).all(req.ctx.ownerKey);
  res.json(rows.map((r) => ({ ...r, days_left: r.status === 'active' || r.status === 'expired' ? daysUntil(r.expiration_date) : null })));
});

app.get('/api/contracts/:id', (req, res) => {
  refreshStatuses();
  const c = ownContract(req, req.params.id);
  const paragraphs = loadParagraphs(c.id);
  const vendor = c.vendor_id ? db.prepare('SELECT id, canonical_name FROM vendor WHERE id = ?').get(c.vendor_id) : null;
  const lookup = vendor?.canonical_name || c.suggested_vendor || '';
  const candidates = lookup ? matchVendors(req.ctx.ownerKey, lookup, 0.5) : [];
  const { file_path, ...contract } = c;
  res.json({
    contract: { ...contract, days_left: daysUntil(c.expiration_date) }, vendor, vendor_candidates: candidates,
    vendor_mode: vendorMode(req.ctx), auto_threshold: AUTO_THRESHOLD,
    fields: loadFields(c.id), flags: loadFlags(c.id, paragraphs), paragraphs,
    regulatory_alerts: regulatoryMatches(req.ctx.ownerKey, c.id),
  });
});

app.get('/api/contracts/:id/file', (req, res) => {
  const c = ownContract(req, req.params.id);
  res.setHeader('Content-Type', c.file_mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(c.file_name)}"`);
  fs.createReadStream(path.join(UPLOAD_DIR, c.file_path)).pipe(res);
});

app.delete('/api/contracts/:id', (req, res) => {
  const c = ownContract(req, req.params.id);
  db.prepare('DELETE FROM contract WHERE id = ?').run(c.id);
  fs.rmSync(path.join(UPLOAD_DIR, c.file_path), { force: true });
  res.json({ ok: true });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function validateFieldValue(name, v) {
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
  const c = ownContract(req, req.params.id);
  if (!['pending_review', 'active', 'expired'].includes(c.status)) throw httpError(409, `A contract in status "${c.status}" cannot be confirmed.`);
  const b = req.body || {};
  const firstReview = c.status === 'pending_review';

  const title = String(b.title || '').trim();
  if (!title) throw httpError(422, 'Give the contract a name.');
  if (!['business_class', 'regulatory_class'].includes(b.contract_type)) throw httpError(422, 'Choose a contract type.');

  const fields = loadFields(c.id);
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
    const missingFields = fields.filter((f) => f.confidence !== 'high' && !ackF.has(f.field_name) && !changed(f)).map((f) => f.field_name);
    const missingFlags = db.prepare('SELECT id FROM clause_flag WHERE contract_id = ?').all(c.id).map((f) => f.id).filter((id) => !ackFl.has(id));
    if (missingFields.length || missingFlags.length) {
      throw httpError(422, 'Review every low/medium-confidence field and every flagged clause before confirming.', { missing_fields: missingFields, missing_flags: missingFlags });
    }
  }

  // Vendor resolution (basic entity resolution; manual vs automatic vendor chain).
  const mode = vendorMode(req.ctx);
  const v = b.vendor || {};
  let vendorId = null, autoMerged = null;
  if (v.id) {
    const row = db.prepare('SELECT id, canonical_name FROM vendor WHERE id = ? AND owner_key = ?').get(Number(v.id), req.ctx.ownerKey);
    if (!row) throw httpError(422, 'That vendor does not exist.');
    vendorId = row.id;
    if (v.name && v.name.trim() !== row.canonical_name) addAlias(row.id, v.name);
  } else {
    const name = String(v.name || '').trim();
    if (!name) throw httpError(422, 'Choose or enter a vendor.');
    const existing = db.prepare('SELECT id FROM vendor WHERE owner_key = ? AND lower(canonical_name) = lower(?)').get(req.ctx.ownerKey, name);
    const candidates = matchVendors(req.ctx.ownerKey, name);
    if (existing) vendorId = existing.id;
    else if (b.vendor_decision === 'new') vendorId = createVendor(req.ctx.ownerKey, name);
    else if (b.vendor_decision === 'merge' && b.merge_id) {
      const row = db.prepare('SELECT id FROM vendor WHERE id = ? AND owner_key = ?').get(Number(b.merge_id), req.ctx.ownerKey);
      if (!row) throw httpError(422, 'That vendor does not exist.');
      vendorId = row.id; addAlias(row.id, name);
    } else if (candidates.length && mode === 'automatic' && candidates[0].score >= AUTO_THRESHOLD) {
      vendorId = candidates[0].id; addAlias(vendorId, name);
      autoMerged = { id: candidates[0].id, name: candidates[0].canonical_name, score: candidates[0].score };
    } else if (candidates.length) {
      throw httpError(409, 'Similar vendors already exist.', { needs_vendor_decision: true, entered: name, candidates });
    } else vendorId = createVendor(req.ctx.ownerKey, name);
  }

  tx(() => {
    const upd = db.prepare('UPDATE contract_field SET corrected_value = ? WHERE contract_id = ? AND field_name = ?');
    for (const f of fields) {
      if (!(f.field_name in edits)) continue;
      upd.run(sameJson(edits[f.field_name], f.extracted_value) ? null : j(edits[f.field_name]), c.id, f.field_name);
    }
    const eff = loadFields(c.id);
    const val = (n) => eff.find((f) => f.field_name === n).value;
    const expiry = val('expiration_date');
    const status = expiry && daysUntil(expiry) < 0 ? 'expired' : 'active';
    db.prepare(`UPDATE contract SET title = ?, contract_type = ?, vendor_id = ?, summary_text = ?, effective_date = ?, expiration_date = ?, status = ?,
      reviewed_by = COALESCE(?, reviewed_by), reviewed_at = COALESCE(?, reviewed_at) WHERE id = ?`)
      .run(title, b.contract_type, vendorId, typeof b.summary_text === 'string' ? b.summary_text : c.summary_text, val('effective_date'), expiry, status,
        firstReview ? req.ctx.user.id : null, firstReview ? now() : null, c.id);
    const setFlag = db.prepare('UPDATE clause_flag SET resolved = ? WHERE id = ? AND contract_id = ?');
    for (const [id, resolved] of Object.entries(b.flag_resolved || {})) setFlag.run(resolved ? 1 : 0, Number(id), c.id);
  });
  const vendor = db.prepare('SELECT id, canonical_name FROM vendor WHERE id = ?').get(vendorId);
  await runReminders(); // a newly active contract may already be inside an alert window
  res.json({ ok: true, id: c.id, vendor, auto_merged: autoMerged });
}));

// ------------------------------------------------------------------ chat (single contract)
app.get('/api/contracts/:id/chat', (req, res) => {
  const c = ownContract(req, req.params.id);
  const rows = db.prepare('SELECT * FROM chat_message WHERE contract_id = ? AND user_id = ? ORDER BY id').all(c.id, req.ctx.user.id);
  res.json(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, citations: unj(m.cited_sources) || [], confidence: m.confidence, created_at: m.created_at })));
});

app.post('/api/contracts/:id/chat', wrap(async (req, res) => {
  const c = ownContract(req, req.params.id);
  if (['processing', 'failed'].includes(c.status)) throw httpError(409, 'This contract has no readable text to ask about.');
  const question = String(req.body?.question || '').trim();
  if (!question) throw httpError(400, 'Ask a question.');
  if (question.length > 2000) throw httpError(400, 'Question is too long (2000 characters max).');
  const paragraphs = loadParagraphs(c.id);
  const history = db.prepare('SELECT role, content FROM chat_message WHERE contract_id = ? AND user_id = ? ORDER BY id').all(c.id, req.ctx.user.id);
  const fields = loadFields(c.id).map((f) => ({ field_name: f.field_name, value: f.value, confidence: f.confidence, corrected: f.was_corrected, source_refs: f.source_refs, rationale: f.rationale }));
  const flags = loadFlags(c.id, paragraphs);
  let out;
  try {
    out = await answerQuestion({ question, paragraphs, fields, flags, history });
  } catch (e) {
    throw httpError(502, `Could not get an answer: ${e.message}`);
  }
  const ins = db.prepare('INSERT INTO chat_message (contract_id, user_id, role, content, cited_sources, confidence, created_at) VALUES (?,?,?,?,?,?,?)');
  ins.run(c.id, req.ctx.user.id, 'user', question, '[]', null, now());
  ins.run(c.id, req.ctx.user.id, 'assistant', out.answer, j(out.citations), out.confidence, now());
  res.json({ role: 'assistant', content: out.answer, citations: out.citations, confidence: out.confidence, mode: out.mode });
}));

app.delete('/api/contracts/:id/chat', (req, res) => {
  const c = ownContract(req, req.params.id);
  db.prepare('DELETE FROM chat_message WHERE contract_id = ? AND user_id = ?').run(c.id, req.ctx.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ vendors
app.get('/api/vendors', (req, res) => {
  refreshStatuses();
  const rows = db.prepare(`
    SELECT v.id, v.canonical_name, v.aliases, COUNT(c.id) AS contract_count,
      SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS active_count,
      MIN(CASE WHEN c.status = 'active' THEN c.expiration_date END) AS next_expiry
    FROM vendor v LEFT JOIN contract c ON c.vendor_id = v.id AND c.status IN ('active','expired','archived')
    WHERE v.owner_key = ? GROUP BY v.id ORDER BY v.canonical_name COLLATE NOCASE`).all(req.ctx.ownerKey);
  res.json(rows.map((r) => ({ ...r, aliases: unj(r.aliases) || [], next_expiry_days: daysUntil(r.next_expiry) })));
});

app.get('/api/vendors/:id', (req, res) => {
  refreshStatuses();
  const v = db.prepare('SELECT * FROM vendor WHERE id = ? AND owner_key = ?').get(Number(req.params.id), req.ctx.ownerKey);
  if (!v) throw httpError(404, 'Vendor not found');
  const contracts = db.prepare(`
    SELECT id, title, contract_type, status, effective_date, expiration_date, uploaded_at, summary_text,
      (SELECT COUNT(*) FROM clause_flag f WHERE f.contract_id = contract.id AND f.resolved = 0) AS open_flags
    FROM contract WHERE vendor_id = ? AND owner_key = ? AND status IN ('active','expired','archived')
    ORDER BY COALESCE(effective_date, substr(uploaded_at, 1, 10)) ASC`).all(v.id, req.ctx.ownerKey);
  const pay = db.prepare("SELECT contract_id, COALESCE(corrected_value, extracted_value) AS v FROM contract_field WHERE field_name = 'payment_terms' AND contract_id IN (SELECT id FROM contract WHERE vendor_id = ?)").all(v.id);
  const payBy = Object.fromEntries(pay.map((p) => [p.contract_id, unj(p.v)]));
  res.json({
    id: v.id, canonical_name: v.canonical_name, aliases: unj(v.aliases) || [],
    contracts: contracts.map((c) => ({ ...c, days_left: daysUntil(c.expiration_date), payment_terms: payBy[c.id] || null })),
  });
});

// ------------------------------------------------------------------ dashboard / reminders
app.get('/api/dashboard', (req, res) => {
  const { ownerKey } = req.ctx;
  const expiring = expiringContracts(ownerKey);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM contract WHERE owner_key = ? GROUP BY status').all(ownerKey).map((r) => [r.status, r.n]));
  const pending = db.prepare("SELECT id, title, uploaded_at FROM contract WHERE owner_key = ? AND status = 'pending_review' ORDER BY uploaded_at DESC").all(ownerKey);
  const notifications = db.prepare('SELECT id, contract_id, message, window_days, created_at, read FROM notification WHERE owner_key = ? ORDER BY id DESC LIMIT 20').all(ownerKey);
  res.json({ expiring, counts, pending, notifications, windows: alertWindows(ownerKey), regulatory_changes: regulatoryMatches(ownerKey), defaults: DEFAULT_ALERT_WINDOWS });
});

app.post('/api/reminders/run', wrap(async (req, res) => {
  const created = await runReminders();
  res.json({ created: created.filter((c) => c.ownerKey === req.ctx.ownerKey).length });
}));
app.post('/api/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notification SET read = 1 WHERE id = ? AND owner_key = ?').run(Number(req.params.id), req.ctx.ownerKey);
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notification SET read = 1 WHERE owner_key = ?').run(req.ctx.ownerKey);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ static + errors
app.use(express.static(path.join(ROOT, 'public')));
app.use('/samples', express.static(path.join(ROOT, 'samples'), { index: false, extensions: ['pdf'], setHeaders: (r) => r.setHeader('Content-Disposition', 'attachment') }));

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (25 MB max).' : err.message });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, ...(err.extra || {}) });
});

app.listen(PORT, () => {
  console.log(`ContractLens running at http://localhost:${PORT}`);
  console.log(MODE === 'live' ? `  extraction/chat: LIVE via Claude (${MODEL})` : '  extraction/chat: OFFLINE demo mode (fixtures for /samples files). Set ANTHROPIC_API_KEY for live Claude.');
});

// Active reminders: check on boot and hourly.
runReminders().catch((e) => console.error('reminder run failed', e));
setInterval(() => runReminders().catch((e) => console.error('reminder run failed', e)), 60 * 60 * 1000).unref();
