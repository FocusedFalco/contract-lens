import { q, one, unj } from './db.js';

export const SUGGEST_THRESHOLD = 0.6; // offer "merge with existing vendor X?"
export const AUTO_THRESHOLD = 0.85;   // automatic vendor chain links without asking

const SUFFIXES = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'the']);

export const normName = (s) => String(s || '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/).filter((t) => t && !SUFFIXES.has(t)).join(' ');

const bigrams = (s) => { const t = s.replace(/ /g, ''); const out = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; };

export function similarity(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x), by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) || 0);
  const dice = (2 * inter) / ([...bx.values()].reduce((s, n) => s + n, 0) + [...by.values()].reduce((s, n) => s + n, 0) || 1);
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  const jac = [...tx].filter((t) => ty.has(t)).length / new Set([...tx, ...ty]).size;
  const prefix = x.startsWith(y) || y.startsWith(x) ? 0.88 : 0; // "Nimbus Cloud" vs "Nimbus Cloud Solutions"
  return Math.max(dice, jac, prefix);
}

/** Existing vendors for this owner ranked by similarity to `name` (canonical name and aliases). */
export async function matchVendors(ownerKey, name, min = SUGGEST_THRESHOLD) {
  const rows = await q('SELECT id, canonical_name, aliases FROM vendor WHERE owner_key = ?', [ownerKey]);
  return rows
    .map((v) => ({ id: v.id, canonical_name: v.canonical_name, score: Math.max(similarity(name, v.canonical_name), ...(unj(v.aliases) || []).map((a) => similarity(name, a)), 0) }))
    .filter((m) => m.score >= min)
    .sort((a, b) => b.score - a.score);
}

export async function createVendor(ownerKey, name, run = { one }) {
  return (await run.one('INSERT INTO vendor (owner_key, canonical_name, aliases) VALUES (?,?,?) RETURNING id', [ownerKey, name.trim(), '[]'])).id;
}

/** Record a spelling variant so future matches on either form are exact. */
export async function addAlias(vendorId, name, run = { q, one }) {
  const v = await run.one('SELECT canonical_name, aliases FROM vendor WHERE id = ?', [vendorId]);
  const aliases = unj(v.aliases) || [];
  const n = name.trim();
  if (n && n !== v.canonical_name && !aliases.includes(n)) {
    aliases.push(n);
    await run.q('UPDATE vendor SET aliases = ? WHERE id = ?', [JSON.stringify(aliases), vendorId]);
  }
}
