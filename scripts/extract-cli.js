// Usage: npm run extract -- samples/foo.pdf [more files]   (add --json for raw output)
import fs from 'node:fs';
import path from 'node:path';
import { extractContract } from '../server/extract.js';
import { MODE, MODEL, PROVIDER } from '../server/config.js';
import { refLabel } from '../server/pdf.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('Usage: npm run extract -- <file.pdf|image> [...] [--json]'); process.exit(1); }
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const mark = { high: '●', medium: '◐', low: '○' };

for (const f of files) {
  const res = await extractContract({ buffer: fs.readFileSync(f), mime: MIME[path.extname(f).toLowerCase()], fileName: path.basename(f), ownerName: 'Acme Traders Pvt Ltd' });
  if (asJson) { console.log(JSON.stringify(res, null, 2)); continue; }
  const byId = Object.fromEntries(res.paragraphs.map((p) => [p.id, p]));
  const cite = (ids) => ids.map((i) => (byId[i] ? refLabel(byId[i]) : i)).join('; ') || 'no source';
  console.log(`\n=== ${f}  [mode=${res.mode}${res.mode.startsWith('live') ? ' model=' + MODEL : ''}, run-mode=${MODE}]`);
  console.log(`${res.title}  |  ${res.contract_type}  |  vendor: ${res.vendor_name}\nquality: ${res.doc_quality}\n`);
  const order = { low: 0, medium: 1, high: 2 };
  for (const [name, v] of Object.entries(res.fields).sort((a, b) => order[a[1].confidence] - order[b[1].confidence])) {
    console.log(`${mark[v.confidence]} ${name.padEnd(22)} ${v.confidence.padEnd(6)} ${JSON.stringify(v.value)}\n    ↳ ${cite(v.source_refs)}${v.rationale ? '  — ' + v.rationale : ''}`);
  }
  console.log(`\nFLAGS (${res.flags.length})`);
  for (const fl of res.flags) console.log(`  ⚑ ${fl.flag_type.padEnd(22)} ${fl.description}\n      ↳ ${fl.source_ref ? cite([fl.source_ref]) : 'no source'}`);
  console.log(`\nSUMMARY\n${res.summary}`);
}
