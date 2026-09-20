import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, now } from './db.js';
import { DATA_DIR, DEFAULT_ALERT_WINDOWS } from './config.js';

const DAY = 86400000;
const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export function daysUntil(isoDate, from = new Date()) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - utcMidnight(from)) / DAY);
}

export const alertWindows = (ownerKey) =>
  [...getSetting(`alert_windows:${ownerKey}`, DEFAULT_ALERT_WINDOWS)].sort((a, b) => a - b);

/** Active contracts whose expiry date has passed become `expired`. */
export function refreshStatuses() {
  const rows = db.prepare("SELECT id, expiration_date FROM contract WHERE status = 'active' AND expiration_date IS NOT NULL").all();
  const upd = db.prepare("UPDATE contract SET status = 'expired' WHERE id = ?");
  for (const r of rows) if (daysUntil(r.expiration_date) < 0) upd.run(r.id);
}

/**
 * Passive reminders: computed on every dashboard load. Returns contracts inside the widest alert
 * window (or already expired in the last 30 days), each tagged with the tightest window it falls in.
 */
export function expiringContracts(ownerKey) {
  refreshStatuses();
  const windows = alertWindows(ownerKey);
  const widest = windows[windows.length - 1];
  const rows = db.prepare(`
    SELECT c.id, c.title, c.expiration_date, c.status, c.contract_type, v.canonical_name AS vendor_name, v.id AS vendor_id
    FROM contract c LEFT JOIN vendor v ON v.id = c.vendor_id
    WHERE c.owner_key = ? AND c.status IN ('active','expired') AND c.expiration_date IS NOT NULL`).all(ownerKey);
  return rows
    .map((r) => ({ ...r, days_left: daysUntil(r.expiration_date) }))
    .filter((r) => r.days_left <= widest && r.days_left >= -30)
    .map((r) => ({ ...r, window: r.days_left < 0 ? null : windows.find((w) => r.days_left <= w) }))
    .sort((a, b) => a.days_left - b.days_left);
}

/**
 * Active reminders: creates one notification per contract per window (only the tightest window that
 * applies, so a contract 5 days from expiry produces one "7 days" reminder, not three), then
 * "delivers" it. Delivery here is an in-app notification + a line in data/outbox.log (a stand-in for
 * email) + an optional POST to ALERT_WEBHOOK_URL.
 */
export async function runReminders() {
  refreshStatuses();
  const owners = db.prepare("SELECT DISTINCT owner_key FROM contract WHERE status = 'active'").all().map((r) => r.owner_key);
  const created = [];
  const insert = db.prepare(`INSERT OR IGNORE INTO notification (owner_key, contract_id, kind, window_days, expiration_date, message, created_at)
    VALUES (?, ?, 'expiry', ?, ?, ?, ?)`);
  for (const ownerKey of owners) {
    for (const c of expiringContracts(ownerKey)) {
      if (c.status !== 'active' || c.window == null) continue;
      const label = c.days_left === 0 ? 'today' : c.days_left === 1 ? 'tomorrow' : `in ${c.days_left} days`;
      const message = `"${c.title}"${c.vendor_name ? ` (${c.vendor_name})` : ''} expires ${label} (${c.expiration_date}). Check renewal/termination terms.`;
      const r = insert.run(ownerKey, c.id, c.window, c.expiration_date, message, now());
      if (r.changes > 0) created.push({ ownerKey, message, window: c.window });
    }
  }
  for (const n of created) await deliver(n);
  return created;
}

async function deliver(n) {
  fs.appendFileSync(path.join(DATA_DIR, 'outbox.log'), `${now()}\t${n.ownerKey}\tEXPIRY-${n.window}d\t${n.message}\n`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: n.message }) });
    } catch (e) { console.warn('alert webhook failed:', e.message); }
  }
}
