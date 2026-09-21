// Loads mock contracts into the open workspace through the real API (so review rules still apply).
// Usage: start the server, then `npm run seed:demo`.  BASE=http://localhost:3210 by default.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3210';
async function api(method, url, { body, form } = {}) {
  const res = await fetch(BASE + '/api' + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: form ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const existing = (await api('GET', '/contracts')).data;
if (existing.length) { console.log(`Workspace already has ${existing.length} contracts; nothing to do.`); process.exit(0); }

async function load(file) {
  const form = new FormData(); form.append('file', new Blob([fs.readFileSync(path.join('public', 'samples', file))], { type: 'application/pdf' }), file);
  const up = await api('POST', '/contracts', { form });
  for (let i = 0; i < 40; i++) { const d = (await api('GET', `/contracts/${up.data.id}`)).data; if (d.contract.status !== 'processing') return d; await new Promise((x) => setTimeout(x, 250)); }
  throw new Error('timeout ' + file);
}
// Mock data only: review + confirm on the user's behalf. The lease is left pending so the review screen has something to show.
const plan = [['nimbus-hosting-order-form-2024.pdf', 'Nimbus Cloud Solutions Pvt Ltd'], ['nimbus-master-services-agreement.pdf', 'Nimbus Cloud Solutions Pvt Ltd'], ['spcb-consent-to-operate.pdf', 'State Pollution Control Board'], ['sunrise-apartment-lease.pdf', null]];
for (const [file, vendor] of plan) {
  const d = await load(file);
  if (!vendor) { console.log(`• ${d.contract.title}: left pending review`); continue; }
  const body = { title: d.contract.title, contract_type: d.contract.contract_type, vendor: { name: vendor },
    acknowledged_fields: d.fields.filter((f) => f.confidence !== 'high').map((f) => f.field_name), acknowledged_flags: d.flags.map((f) => f.id) };
  let c = await api('POST', `/contracts/${d.contract.id}/confirm`, { body });
  if (c.status === 409 && c.data?.needs_vendor_decision) c = await api('POST', `/contracts/${d.contract.id}/confirm`, { body: { ...body, vendor_decision: 'merge', merge_id: c.data.candidates[0].id } });
  console.log(`• ${d.contract.title}: ${c.status === 200 ? 'active' : 'FAILED ' + JSON.stringify(c.data)}`);
}
console.log(`\nOpen ${BASE}`);
