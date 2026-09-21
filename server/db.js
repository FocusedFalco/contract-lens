import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// One SQL dialect everywhere (Postgres):
//  - DATABASE_URL set  -> node-postgres against that database (Supabase, Neon, ...).
//  - otherwise         -> PGlite, an embedded real Postgres persisted under ./data/pglite (local dev + tests).
// All access is async. Await `ready` before the first query.

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }; // write `?` placeholders, sent as $1, $2, ...
const bind = (run) => {
  const q = (sql, params = []) => run(toPg(sql), params.map((v) => (v === undefined ? null : v)));
  return { q, one: async (sql, params) => (await q(sql, params))[0] };
};

async function makeDriver() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    // max: 3 keeps serverless instances from exhausting the pooler; Supabase requires TLS.
    const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, ssl: local ? false : { rejectUnauthorized: false } });
    const run = async (sql, params) => (await pool.query(sql, params)).rows;
    return {
      kind: 'postgres', ...bind(run), exec: (sql) => pool.query(sql),
      tx: async (fn) => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(bind(async (s, p) => (await c.query(s, p)).rows)); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.CL_PGLITE_DIR || path.join(DATA_DIR, 'pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite', ...bind(async (s, p) => (await db.query(s, p)).rows), exec: (sql) => db.exec(sql),
    tx: (fn) => db.transaction((t) => fn(bind(async (s, p) => (await t.query(s, p)).rows))),
  };
}

const SCHEMA = `
-- No accounts: one open workspace, so every row is owned by 'workspace:1' (owner_key kept so multi-tenancy can return).
CREATE TABLE IF NOT EXISTS vendor (
  id SERIAL PRIMARY KEY, owner_key TEXT NOT NULL, canonical_name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS contract (
  id SERIAL PRIMARY KEY, owner_key TEXT NOT NULL, vendor_id INTEGER REFERENCES vendor(id),
  title TEXT, contract_type TEXT CHECK (contract_type IN ('business_class','regulatory_class')),
  file_name TEXT NOT NULL, file_data BYTEA, file_mime TEXT NOT NULL, file_sha TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL DEFAULT 1, uploaded_at TEXT NOT NULL,
  effective_date TEXT, expiration_date TEXT, summary_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','failed','pending_review','active','expired','archived')),
  extraction_mode TEXT, error TEXT, doc_quality TEXT, suggested_vendor TEXT, reviewed_by INTEGER, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS paragraph (
  seq SERIAL, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  id TEXT NOT NULL, page INTEGER NOT NULL, clause TEXT, text TEXT NOT NULL, PRIMARY KEY (contract_id, id)
);
CREATE TABLE IF NOT EXISTS contract_field (
  contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL, extracted_value TEXT, corrected_value TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  source_refs TEXT NOT NULL DEFAULT '[]', rationale TEXT,
  PRIMARY KEY (contract_id, field_name)
);
CREATE TABLE IF NOT EXISTS clause_flag (
  id SERIAL PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL, description TEXT NOT NULL, source_ref TEXT, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_message (
  id SERIAL PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL, cited_sources TEXT NOT NULL DEFAULT '[]', confidence TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Active reminders: one row per (contract, expiry date, window) so a reminder fires once.
CREATE TABLE IF NOT EXISTS notification (
  id SERIAL PRIMARY KEY, owner_key TEXT NOT NULL, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, window_days INTEGER NOT NULL, expiration_date TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
  UNIQUE (contract_id, kind, window_days, expiration_date)
);
CREATE TABLE IF NOT EXISTS regulation_update (
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, authority TEXT NOT NULL, summary TEXT NOT NULL,
  published TEXT NOT NULL, effective TEXT NOT NULL, keywords TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_owner ON contract(owner_key, status);
CREATE INDEX IF NOT EXISTS idx_contract_vendor ON contract(vendor_id);
`;

export const now = () => new Date().toISOString();
export const j = (v) => JSON.stringify(v ?? null);
export const unj = (s) => (s == null ? null : JSON.parse(s));

let driver;
export const q = (sql, params) => driver.q(sql, params);
export const one = (sql, params) => driver.one(sql, params);
/** Run fn inside a transaction; fn receives { q, one } bound to that transaction. */
export const tx = (fn) => driver.tx(fn);
export const dbKind = () => driver?.kind;

export const getSetting = async (key, fallback) => {
  const row = await one('SELECT value FROM setting WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : fallback;
};
export const setSetting = (key, value) =>
  q('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);

async function seed() {
  if ((await one('SELECT COUNT(*)::int AS n FROM regulation_update')).n > 0) return;
  const ins = 'INSERT INTO regulation_update (title, authority, summary, published, effective, keywords) VALUES (?,?,?,?,?,?)';
  await q(ins, ['Revised industrial emission limits for particulate matter', 'Ministry of Environment (DEMO DATA)',
    'Tightens permitted particulate-matter limits for industrial units and requires re-filing of consent conditions within 90 days of the effective date.',
    '2026-09-01', '2026-11-30', j(['emission', 'consent', 'pollution', 'environment'])]);
  await q(ins, ['Mandatory minimum cover for commercial property insurance', 'Insurance Regulatory Authority (DEMO DATA)',
    'Raises the minimum sum-insured for commercial property policies and mandates a 30-day grace period on premium renewal.',
    '2026-08-15', '2027-01-01', j(['insurance', 'premium', 'policy', 'sum insured'])]);
}

async function init() {
  driver = await makeDriver();
  await driver.exec(SCHEMA);
  await seed();
}
export const ready = init();
ready.catch(() => {}); // surfaced per-request by the app; avoids a crash on unhandled rejection
