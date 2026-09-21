import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MODE, PROVIDER, FIXTURE_DIR } from './config.js';
import { generateJson } from './llm.js';
import { pdfPageTexts, splitParagraphs, hasTextLayer } from './pdf.js';

export const FIELD_NAMES = ['parties', 'effective_date', 'expiration_date', 'renewal_terms', 'payment_terms', 'termination_conditions', 'service_obligations'];
export const FLAG_TYPES = ['auto_renewal', 'unilateral_termination', 'penalty', 'indemnity', 'other'];
export const RECURRENCES = ['one-time', 'monthly', 'quarterly', 'annual', 'other', 'unknown'];
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const isSupportedMime = (m) => m === 'application/pdf' || IMAGE_MIME.has(m);

// ------------------------------------------------------------------ schemas (structured outputs)
const nullable = (t) => ({ type: [t, 'null'] });
const field = (valueSchema) => ({
  type: 'object',
  properties: {
    value: valueSchema,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    source_refs: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['value', 'confidence', 'source_refs', 'rationale'],
  additionalProperties: false,
});

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    contract_type: { type: 'string', enum: ['business_class', 'regulatory_class'] },
    vendor_name: { type: 'string' },
    doc_quality: { type: 'string' },
    fields: {
      type: 'object',
      properties: {
        parties: field({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } }, required: ['name', 'role'], additionalProperties: false } }),
        effective_date: field(nullable('string')),
        expiration_date: field(nullable('string')),
        renewal_terms: field(nullable('string')),
        payment_terms: field({
          type: 'object',
          properties: { amount: nullable('number'), currency: nullable('string'), recurrence: { type: 'string', enum: RECURRENCES }, due_rule: nullable('string') },
          required: ['amount', 'currency', 'recurrence', 'due_rule'], additionalProperties: false,
        }),
        termination_conditions: field(nullable('string')),
        service_obligations: field({ type: 'array', items: { type: 'string' } }),
      },
      required: FIELD_NAMES, additionalProperties: false,
    },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: { flag_type: { type: 'string', enum: FLAG_TYPES }, description: { type: 'string' }, source_ref: { type: 'string' } },
        required: ['flag_type', 'description', 'source_ref'], additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['title', 'contract_type', 'vendor_name', 'doc_quality', 'fields', 'flags', 'summary'],
  additionalProperties: false,
};

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    legibility: { type: 'string', enum: ['good', 'poor', 'handwritten'] },
    notes: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: { type: 'object', properties: { page: { type: 'integer' }, clause: nullable('string'), text: { type: 'string' } }, required: ['page', 'clause', 'text'], additionalProperties: false },
    },
  },
  required: ['legibility', 'notes', 'paragraphs'], additionalProperties: false,
};

const EXTRACTION_SYSTEM = `You extract structured data from a contract for a review tool used by people with no legal training. The contract is given as paragraphs, each tagged with an ID like [P2.3] (page 2, paragraph 3).

Rules:
- Use only what the text says. Never invent values. If a field is not stated, set its value to null (an empty list for service_obligations) and confidence to "low".
- confidence: "high" = stated explicitly and unambiguous. "medium" = needs inference or calculation (for example an expiry date computed from a start date plus a term), is only partly stated, or is spread across several clauses. "low" = missing, ambiguous, contradictory, refers to something not in the document (an unattached schedule, annex or rate card), or the source text is unclear. Be honest: do not label something "high" unless you would bet on it.
- source_refs: the paragraph IDs that support the value, exactly as tagged. Every non-null value needs at least one.
- Dates are ISO YYYY-MM-DD. payment_terms.amount is a plain number; recurrence is one of one-time, monthly, quarterly, annual, other, unknown. If several amounts exist, use the main recurring fee and mention extras in due_rule.
- vendor_name: the counterparty the document's owner is dealing with, i.e. the party that is NOT the owner. If the owner is not a party, use the party that provides the service or issues the document. Use the name exactly as written.
- contract_type: "regulatory_class" for government contracts, licences, permits, consents, insurance and regulated services; otherwise "business_class" (bills, land, loans, supply and service agreements).
- flags: clauses a human should review before relying on the contract. Types: auto_renewal (automatic or evergreen renewal, especially with a notice window), unilateral_termination (one party can terminate, suspend or change terms freely and the other cannot), penalty (late fees, liquidated damages, forfeiture, early-termination charges, fines), indemnity (indemnities, one-sided or uncapped liability), other (unilateral price changes, broad assignment rights, missing schedules, very short deadlines, anything else a layperson should not sign without understanding). Each flag cites exactly one paragraph ID and describes the issue in one or two plain sentences. Do not flag ordinary boilerplate.
- summary: 80 to 160 words, plain language for a non-lawyer: what this is, what they pay and when, how long it lasts, how it renews or ends, and the biggest risks. No legal jargon.
- doc_quality: one sentence noting any problem (illegible parts, missing schedules or pages). Say "No issues" if clean.`;

const TRANSCRIBE_SYSTEM = `You transcribe a photographed or scanned contract into paragraphs, in reading order. Keep numbered clauses (e.g. "4.2") as separate paragraphs and copy the clause number into "clause" (null if none). Transcribe exactly; never fix, guess or complete text. Write [illegible] where you cannot read something. Set legibility to "handwritten" if the main content is handwritten, "poor" if a lot is hard to read, else "good". Use "notes" to mention cut-off edges, missing pages, stamps or signatures.`;

// ------------------------------------------------------------------ helpers
const tagged = (paragraphs) => paragraphs.map((p) => `[${p.id}] ${p.text}`).join('\n\n');

/** Turn model-transcribed paragraphs into the same shape the PDF splitter produces. */
function idParagraphs(items) {
  const perPage = {};
  return items.map((it) => {
    const page = it.page || 1;
    perPage[page] = (perPage[page] || 0) + 1;
    return { id: `P${page}.${perPage[page]}`, page, clause: it.clause || null, text: it.text };
  });
}

// ------------------------------------------------------------------ normalisation (enforces non-negotiables)
export function normalise(raw, paragraphs, { forceLow = false } = {}) {
  const ids = new Set(paragraphs.map((p) => p.id));
  const validRefs = (refs) => [...new Set((refs || []).filter((r) => ids.has(r)))];
  const LEVELS = ['low', 'medium', 'high'];
  const cap = (c, max) => LEVELS[Math.min(LEVELS.indexOf(c), LEVELS.indexOf(max))];

  const fields = {};
  for (const name of FIELD_NAMES) {
    const f = raw.fields?.[name] ?? { value: null, confidence: 'low', source_refs: [], rationale: 'Not returned by the extractor.' };
    const refs = validRefs(f.source_refs);
    const empty = f.value == null || (Array.isArray(f.value) && f.value.length === 0);
    let confidence = LEVELS.includes(f.confidence) ? f.confidence : 'low';
    let rationale = f.rationale || '';
    if (empty) confidence = 'low';
    else if (refs.length === 0) { confidence = 'low'; rationale = `${rationale} (No source paragraph could be located.)`.trim(); }
    if (forceLow) confidence = 'low';
    fields[name] = { value: empty && name !== 'service_obligations' ? null : f.value, confidence, source_refs: refs, rationale };
  }

  const flags = (raw.flags || []).map((fl) => ({
    flag_type: FLAG_TYPES.includes(fl.flag_type) ? fl.flag_type : 'other',
    description: fl.description,
    source_ref: ids.has(fl.source_ref) ? fl.source_ref : null,
  }));

  return {
    title: raw.title || '',
    contract_type: raw.contract_type === 'regulatory_class' ? 'regulatory_class' : 'business_class',
    vendor_name: raw.vendor_name || '',
    doc_quality: forceLow ? `${raw.doc_quality || ''} Handwritten or poor-quality document: every field is marked low confidence and manual entry is recommended.`.trim() : raw.doc_quality || '',
    fields, flags, summary: raw.summary || '', paragraphs,
  };
}

// ------------------------------------------------------------------ paragraphs for a file
async function transcribeWithVision(buffer, mime) {
  const out = await generateJson({
    system: TRANSCRIBE_SYSTEM, schema: TRANSCRIBE_SCHEMA, effort: 'low', what: 'transcription',
    messages: [{ role: 'user', content: 'Transcribe this contract into paragraphs.' }], media: { mime, base64: buffer.toString('base64') },
  });
  return { paragraphs: idParagraphs(out.paragraphs), legibility: out.legibility, notes: out.notes };
}

async function getParagraphs(buffer, mime) {
  if (mime === 'application/pdf') {
    const pages = await pdfPageTexts(buffer);
    if (hasTextLayer(pages)) return { paragraphs: splitParagraphs(pages), legibility: 'good', notes: '' };
  }
  if (MODE !== 'live') {
    throw new Error('This file is an image or scanned PDF with no text layer. Reading it needs an AI key (set GEMINI_API_KEY or ANTHROPIC_API_KEY and restart); the offline demo mode only supports text PDFs.');
  }
  return transcribeWithVision(buffer, mime);
}

// ------------------------------------------------------------------ public API
/**
 * @returns {Promise<{title, contract_type, vendor_name, doc_quality, fields, flags, summary, paragraphs, mode}>}
 */
export async function extractContract({ buffer, mime, fileName, ownerName }) {
  const { paragraphs, legibility, notes } = await getParagraphs(buffer, mime);
  if (paragraphs.length === 0) throw new Error('No readable text found in this document.');
  const forceLow = legibility === 'handwritten' || legibility === 'poor';

  if (MODE !== 'live') {
    const fixturePath = path.join(FIXTURE_DIR, `${sha256(buffer)}.json`);
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Offline demo mode has no pre-computed extraction for "${fileName}". Upload one of the sample files, or set GEMINI_API_KEY (or ANTHROPIC_API_KEY) and restart for live extraction of any contract.`);
    }
    const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const fields = Object.fromEntries(Object.entries(fx.fields).map(([k, v]) => [k, { value: v.value, confidence: v.confidence, source_refs: v.refs, rationale: v.rationale }]));
    return { ...normalise({ ...fx, fields }, paragraphs), mode: 'offline-fixture' };
  }

  const raw = await generateJson({
    system: EXTRACTION_SYSTEM, schema: EXTRACTION_SCHEMA, effort: 'medium', what: 'extraction',
    messages: [{ role: 'user', content: `Document owner (the user's own name/organisation): ${ownerName}\nFile name: ${fileName}\n\n<contract>\n${tagged(paragraphs)}\n</contract>` }],
  });
  if (notes) raw.doc_quality = `${raw.doc_quality || ''} ${notes}`.trim();
  return { ...normalise(raw, paragraphs, { forceLow }), mode: `live-${PROVIDER}` };
}

export { tagged };
