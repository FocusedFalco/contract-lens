import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, UPLOAD_DIR, DB_PATH } from './config.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS org (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry TEXT, invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  phone TEXT, country TEXT, job_title TEXT,
  account_type TEXT NOT NULL CHECK (account_type IN ('customer','business')),
  org_id INTEGER REFERENCES org(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON user(email);
-- Every member of an organisation has the same permissions (no uploader/viewer split).
CREATE TABLE IF NOT EXISTS org_member (
  org_id INTEGER NOT NULL REFERENCES org(id), user_id INTEGER NOT NULL REFERENCES user(id),
  joined_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
-- owner_key is 'org:<id>' for business users and 'user:<id>' for customers: it scopes every row.
CREATE TABLE IF NOT EXISTS vendor (
  id INTEGER PRIMARY KEY, owner_key TEXT NOT NULL, canonical_name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS contract (
  id INTEGER PRIMARY KEY, owner_key TEXT NOT NULL, vendor_id INTEGER REFERENCES vendor(id),
  title TEXT, contract_type TEXT CHECK (contract_type IN ('business_class','regulatory_class')),
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_mime TEXT NOT NULL, file_sha TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES user(id), uploaded_at TEXT NOT NULL,
  effective_date TEXT, expiration_date TEXT, summary_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','failed','pending_review','active','expired','archived')),
  extraction_mode TEXT, error TEXT, doc_quality TEXT, suggested_vendor TEXT,
  reviewed_by INTEGER REFERENCES user(id), reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS paragraph (
  contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
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
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL, description TEXT NOT NULL, source_ref TEXT, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_message (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL, cited_sources TEXT NOT NULL DEFAULT '[]', confidence TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Active reminders: one row per (contract, expiry date, window) so a reminder fires once.
CREATE TABLE IF NOT EXISTS notification (
  id INTEGER PRIMARY KEY, owner_key TEXT NOT NULL, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, window_days INTEGER NOT NULL, expiration_date TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
  UNIQUE (contract_id, kind, window_days, expiration_date)
);
CREATE TABLE IF NOT EXISTS regulation_update (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, authority TEXT NOT NULL, summary TEXT NOT NULL,
  published TEXT NOT NULL, effective TEXT NOT NULL, keywords TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_owner ON contract(owner_key, status);
CREATE INDEX IF NOT EXISTS idx_contract_vendor ON contract(vendor_id);
`);

export const now = () => new Date().toISOString();
export const j = (v) => JSON.stringify(v ?? null);
export const unj = (s) => (s == null ? null : JSON.parse(s));

export const getSetting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
};
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));

/** Run fn inside a transaction (node:sqlite has no helper for this). */
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM regulation_update').get().n > 0) return;
  const r = db.prepare('INSERT INTO regulation_update (title, authority, summary, published, effective, keywords) VALUES (?,?,?,?,?,?)');
  r.run(
    'Revised industrial emission limits for particulate matter',
    'Ministry of Environment (DEMO DATA)',
    'Tightens permitted particulate-matter limits for industrial units and requires re-filing of consent conditions within 90 days of the effective date.',
    '2026-09-01', '2026-11-30', j(['emission', 'consent', 'pollution', 'environment']),
  );
  r.run(
    'Mandatory minimum cover for commercial property insurance',
    'Insurance Regulatory Authority (DEMO DATA)',
    'Raises the minimum sum-insured for commercial property policies and mandates a 30-day grace period on premium renewal.',
    '2026-08-15', '2027-01-01', j(['insurance', 'premium', 'policy', 'sum insured']),
  );
}
seed();
