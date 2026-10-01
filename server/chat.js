import { MODE, PROVIDER, WEB_SEARCH } from './config.js';
import { generateJson, generateJsonWithWebSearch } from './llm.js';
import { tagged } from './extract.js';
import { refLabel } from './pdf.js';

const STOP = new Set('a an the of to in on for and or is are was be by with at as it this that what which who when how do does can i my me we our you your if any there their its from about under over into than then so not no'.split(' '));
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

/** tf-idf-ish ranking of paragraphs against a question. Used for long contracts and for offline mode. */
export function retrieve(paragraphs, question, k = 6) {
  const q = new Set(tokens(question));
  const docs = paragraphs.map((p) => tokens(p.text));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = paragraphs.length;
  return paragraphs
    .map((p, i) => {
      let s = 0;
      for (const t of docs[i]) if (q.has(t)) s += Math.log(1 + N / (df.get(t) || 1));
      return { p, s: s / Math.sqrt(docs[i].length || 1) };
    })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.p);
}

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    citations: { type: 'array', items: { type: 'object', properties: { para_id: { type: 'string' }, quote: { type: 'string' } }, required: ['para_id', 'quote'], additionalProperties: false } },
  },
  required: ['answerable', 'answer', 'confidence', 'citations'], additionalProperties: false,
};

const CHAT_SYSTEM = `You answer questions about ONE contract for a person with no legal training. The contract is given as paragraphs tagged with IDs like [P2.3].

Rules:
- Answer only from the paragraphs provided. Do not use outside knowledge about what such contracts "usually" say.
- Every factual claim must be supported by at least one citation: put the paragraph ID in "para_id" and a short verbatim quote from that paragraph in "quote". Never cite an ID that is not in the contract.
- If the contract does not address the question, set answerable to false, say plainly that the document does not cover it, give no citations, and set confidence to "low".
- Confidence: "high" = the text answers the question directly. "medium" = the answer needs some inference or combines several clauses. "low" = the text is ambiguous, incomplete, refers to a document not provided, or you are unsure. When confidence is "low", begin the answer with "I'm not certain:" and explain what is unclear.
- Fields marked as user-confirmed are values the user checked and corrected; prefer them if they conflict with your reading, and say so.
- Be concise (under 150 words), in plain language. You are not a lawyer: for decisions with real money or legal consequences, add one short sentence suggesting a professional review.`;

// Web-search-enabled variant (CL_WEB_SEARCH=true, Gemini only — see generateJsonWithWebSearch in llm.js). The
// model gets a live Google Search tool alongside the contract text and decides per-question whether to use it;
// "citations" (contract paragraphs) keeps its existing meaning and validation below, "web_citations" is
// attached separately, from Gemini's own grounding metadata, after the call — see answerQuestion.
const CHAT_SYSTEM_WEB = `${CHAT_SYSTEM}

You also have live Google Search available as a tool. Decide per question whether you need it:
- Purely about what this contract says (a date, a fee, a clause): answer from the contract only. Do not search.
- About current events, rates, regulations, or general/public information the contract can't contain: search, and ground your answer in what you find.
- Comparing or combining the two (e.g. "is this penalty normal?", "has this regulation changed since the contract was signed?"): use both, and say which is which — e.g. "According to the contract... / A current web search found...". Never blend a web fact into a sentence about what the contract says without marking it as external.
- If the contract and a search result conflict about what THIS CONTRACT itself says or requires, the contract's own text is authoritative; mention the external information as context, not as a correction to the contract.
- If neither the contract nor a search gives you enough to answer, set answerable to false and reply exactly: "I cannot find sufficient information within internal documents or external data to answer this completely."`;

const fieldText = (fields) => fields.map((f) => `- ${f.field_name}: ${JSON.stringify(f.value)} (confidence: ${f.confidence}${f.corrected ? ', user-confirmed correction' : ''})`).join('\n');

// ------------------------------------------------------------------ offline mode
const fmt = (name, v) => {
  if (v == null) return 'not stated';
  if (name === 'parties') return v.map((p) => `${p.name} (${p.role})`).join('; ');
  if (name === 'payment_terms') {
    const amt = v.amount != null ? `${v.currency || ''} ${Number(v.amount).toLocaleString('en-US')}`.trim() : 'an amount that is not stated in this document';
    return `${amt}, ${v.recurrence}${v.due_rule ? `. ${v.due_rule}` : ''}`;
  }
  if (Array.isArray(v)) return v.map((x) => `• ${x}`).join('\n');
  return String(v);
};

const INTENTS = [
  { re: /\b(expir|end date|end on|valid until|how long|last until|run until|when does)/i, fields: ['expiration_date', 'effective_date'], flags: [] },
  { re: /\b(renew|auto.?renew|evergreen|extend|roll over)/i, fields: ['renewal_terms'], flags: ['auto_renewal'] },
  { re: /\b(pay|fee|cost|price|amount|rent|invoice|charge|how much|instal|due)/i, fields: ['payment_terms'], flags: [] },
  { re: /\b(terminat|cancel|exit|quit|leave|break the|walk away|notice)/i, fields: ['termination_conditions'], flags: ['unilateral_termination'] },
  { re: /\b(penalt|late|fine|forfeit|liquidated|damages|punish)/i, fields: [], flags: ['penalty'] },
  { re: /\b(indemn|liab|responsible for claims)/i, fields: [], flags: ['indemnity'] },
  { re: /\b(obligat|provide|responsib|must|duty|duties|deliver|service|expected)/i, fields: ['service_obligations'], flags: [] },
  { re: /\b(who|part(y|ies)|between|counterparty)/i, fields: ['parties'], flags: [] },
  { re: /\b(risk|red flag|concern|watch out|unfair|trap|careful|problem|dangerous)/i, fields: [], flags: ['*'] },
];
const LEVELS = ['low', 'medium', 'high'];

function offlineAnswer(question, { paragraphs, fields, flags }) {
  const byId = Object.fromEntries(paragraphs.map((p) => [p.id, p]));
  const hits = INTENTS.filter((i) => i.re.test(question));
  const parts = [];
  const cites = new Map();
  let conf = 'high';
  const cite = (id) => { if (byId[id] && !cites.has(id)) cites.set(id, { para_id: id, quote: byId[id].text.slice(0, 220) }); };

  for (const h of hits) {
    for (const name of h.fields) {
      const f = fields.find((x) => x.field_name === name);
      if (!f) continue;
      parts.push(`${name.replace(/_/g, ' ')}: ${fmt(name, f.value)}`);
      f.source_refs.forEach(cite);
      if (LEVELS.indexOf(f.confidence) < LEVELS.indexOf(conf)) conf = f.confidence;
      if (f.confidence === 'low') parts.push(`(The extractor was not confident about this field${f.rationale ? `: ${f.rationale}` : ''}.)`);
    }
    for (const t of h.flags) {
      for (const fl of flags.filter((x) => t === '*' || x.flag_type === t)) {
        parts.push(`⚑ ${fl.description}`);
        if (fl.source_ref) cite(fl.source_ref);
      }
    }
  }
  if (parts.length) {
    if (conf === 'high' && hits.some((h) => h.flags.includes('*'))) conf = 'medium';
    return { answerable: true, confidence: conf, answer: `${parts.join('\n')}\n\n(Offline demo mode: assembled from the reviewed contract fields, not generated by Claude.)`, citations: [...cites.values()] };
  }
  const top = retrieve(paragraphs, question, 3);
  if (top.length) {
    top.forEach((p) => cite(p.id));
    return { answerable: true, confidence: 'low', answer: `I'm not certain: offline demo mode can't interpret free-form questions. These are the clauses that look most relevant, so please read them directly:\n${top.map((p) => `• ${refLabel(p)}: "${p.text.slice(0, 200)}${p.text.length > 200 ? '…' : ''}"`).join('\n')}`, citations: [...cites.values()] };
  }
  return { answerable: false, confidence: 'low', answer: "I'm not certain: I couldn't find anything in this contract that relates to that question, so I can't answer it from the document.", citations: [] };
}

// ------------------------------------------------------------------ public API
export async function answerQuestion({ question, paragraphs, fields, flags, history }) {
  let out, mode;
  if (MODE !== 'live') {
    out = offlineAnswer(question, { paragraphs, fields, flags });
    mode = 'offline';
  } else {
    const total = paragraphs.reduce((n, p) => n + p.text.length, 0);
    let ctx = paragraphs;
    if (total > 80000) { // long contract: retrieve the relevant clauses (plus neighbours) instead of sending everything
      const picked = new Set();
      for (const p of retrieve(paragraphs, question, 25)) {
        const i = paragraphs.indexOf(p);
        [i - 1, i, i + 1].forEach((j) => paragraphs[j] && picked.add(paragraphs[j].id));
      }
      ctx = paragraphs.filter((p) => picked.has(p.id));
    }
    const context = `<reviewed_fields>\n${fieldText(fields)}\n</reviewed_fields>\n\n<contract>\n${tagged(ctx)}\n</contract>`;
    const msgs = [...history.slice(-6).map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: question }];

    if (WEB_SEARCH && PROVIDER === 'gemini') {
      try {
        out = await generateJsonWithWebSearch({ system: CHAT_SYSTEM_WEB, schema: CHAT_SCHEMA, what: 'answer', context, messages: msgs });
        mode = out.searched ? `live-${PROVIDER}-web` : `live-${PROVIDER}`;
      } catch (e) {
        // Most commonly: the Google Cloud project has no (or no paid) Search Grounding quota — see config.js.
        // Never let that take the chatbot down; fall straight back to the proven contract-only path below.
        console.warn('web-search chat call failed, falling back to contract-only:', e.message);
      }
    }
    if (!out) {
      out = await generateJson({ system: CHAT_SYSTEM, schema: CHAT_SCHEMA, effort: 'low', what: 'answer', context, messages: msgs });
      mode = `live-${PROVIDER}`;
    }
  }

  // Enforce the non-negotiables regardless of what the model returned.
  const byId = Object.fromEntries(paragraphs.map((p) => [p.id, p]));
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  const citations = (out.citations || []).filter((c) => byId[c.para_id]).map((c) => {
    const p = byId[c.para_id];
    const quoteOk = c.quote && norm(p.text).includes(norm(c.quote).replace(/…$/, ''));
    return { para_id: c.para_id, label: refLabel(p), page: p.page, quote: quoteOk ? c.quote : p.text.slice(0, 220) };
  });
  // External sources (if any): attached by generateJsonWithWebSearch from Gemini's own grounding metadata, not
  // asked of the model, so there is nothing to validate against — just sanity-check the shape.
  const webCitations = (out.web_citations || [])
    .filter((c) => c && typeof c.url === 'string' && c.url)
    .map((c) => ({ title: String(c.title || 'Web source').slice(0, 200), url: c.url }))
    .slice(0, 6);
  let { answer, confidence } = out;
  if (!LEVELS.includes(confidence)) confidence = 'low';
  if (out.answerable && citations.length === 0 && webCitations.length === 0) {
    confidence = 'low';
    answer = `I'm not certain: I couldn't tie this answer to a specific clause${webCitations.length === 0 && mode.endsWith('-web') ? ' or a web source' : ''}. ${answer.replace(/^I'm not certain:\s*/i, '')}`;
  }
  if (confidence === 'low' && !/^I'm not certain/i.test(answer)) answer = `I'm not certain: ${answer}`;
  return { answer, confidence, citations, web_citations: webCitations, mode };
}
