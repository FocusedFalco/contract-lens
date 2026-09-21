import fs from 'node:fs';
import path from 'node:path';
import { q, getSetting, now } from './db.js';
import { DATA_DIR, DEFAULT_ALERT_WINDOWS } from './config.js';

const DAY = 86400000;
const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export function daysUntil(isoDate, from = new Date()) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - utcMidnight(from)) / DAY);
}

export const alertWindows = async (ownerKey) =>
  [...(await getSetting(`alert_windows:${ownerKey}`, DEFAULT_ALERT_WINDOWS))].sort((a, b) => a - b);

/** Active contracts whose expiry date has passed become `expired`. */
export async function refreshStatuses() {
  const rows = await q("SELECT id, expiration_date FROM contract WHERE status = 'active' AND expiration_date IS NOT NULL");
  for (const r of rows) if (daysUntil(r.expiration_date) < 0) await q("UPDATE contract SET status = 'expired' WHERE id = ?", [r.id]);
}

/**
 * Passive reminders: computed on every dashboard load. Returns contracts inside the widest alert
 * window (or already expired in the last 30 days), each tagged with the tightest window it falls in.
 */
export async function expiringContracts(ownerKey) {
  await refreshStatuses();
  const windows = await alertWindows(ownerKey);
  const widest = windows[windows.length - 1];
  const rows = await q(`
    SELECT c.id, c.title, c.expiration_date, c.status, c.contract_type, v.canonical_name AS vendor_name, v.id AS vendor_id
    FROM contract c LEFT JOIN vendor v ON v.id = c.vendor_id
    WHERE c.owner_key = ? AND c.status IN ('active','expired') AND c.expiration_date IS NOT NULL`, [ownerKey]);
  return rows
    .map((r) => ({ ...r, days_left: daysUntil(r.expiration_date) }))
    .filter((r) => r.days_left <= widest && r.days_left >= -30)
    .map((r) => ({ ...r, window: r.days_left < 0 ? null : windows.find((w) => r.days_left <= w) }))
    .sort((a, b) => a.days_left - b.days_left);
}

/**
 * Active reminders: creates one notification per contract per window (only the tightest window that
 * applies, so a contract 5 days from expiry produces one "7 days" reminder, not three), then
 * "delivers" it: in-app notification + log line (+ data/outbox.log locally) + optional POST to
 * ALERT_WEBHOOK_URL. Serverless hosts have no background timer, so this is also called on dashboard load.
 */
export async function runReminders() {
  await refreshStatuses();
  const owners = (await q("SELECT DISTINCT owner_key FROM contract WHERE status = 'active'")).map((r) => r.owner_key);
  const created = [];
  for (const ownerKey of owners) {
    for (const c of await expiringContracts(ownerKey)) {
      if (c.status !== 'active' || c.window == null) continue;
      const label = c.days_left === 0 ? 'today' : c.days_left === 1 ? 'tomorrow' : `in ${c.days_left} days`;
      const message = `"${c.title}"${c.vendor_name ? ` (${c.vendor_name})` : ''} expires ${label} (${c.expiration_date}). Check renewal/termination terms.`;
      const ins = await q(`INSERT INTO notification (owner_key, contract_id, kind, window_days, expiration_date, message, created_at)
        VALUES (?, ?, 'expiry', ?, ?, ?, ?) ON CONFLICT (contract_id, kind, window_days, expiration_date) DO NOTHING RETURNING id`,
      [ownerKey, c.id, c.window, c.expiration_date, message, now()]);
      if (ins.length) created.push({ ownerKey, message, window: c.window });
    }
  }
  for (const n of created) await deliver(n);
  return created;
}

async function deliver(n) {
  console.log(`[reminder] EXPIRY-${n.window}d ${n.message}`);
  if (!process.env.VERCEL) { // no writable disk on serverless hosts
    try { fs.appendFileSync(path.join(DATA_DIR, 'outbox.log'), `${now()}\t${n.ownerKey}\tEXPIRY-${n.window}d\t${n.message}\n`); } catch { /* best effort */ }
  }
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: n.message }) }); }
    catch (e) { console.warn('alert webhook failed:', e.message); }
  }
}
