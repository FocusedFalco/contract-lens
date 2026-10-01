import Anthropic from '@anthropic-ai/sdk';
import { PROVIDER, MODEL } from './config.js';

// One entry point for "give me JSON matching this schema" so extraction and chat work with either provider.
//   generateJson({ system, context?, messages, media?, schema, effort?, what? }) -> parsed object
//   messages: [{ role: 'user'|'assistant', content }]   media: { mime, base64 } attached to the last user message
let _anthropic;
const anthropic = () => (_anthropic ??= new Anthropic());

export async function generateJson(args) {
  if (PROVIDER === 'gemini') return viaGemini(args);
  if (PROVIDER === 'anthropic') return viaAnthropic(args);
  throw new Error('No AI provider configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.');
}

const startWithUser = (messages) => { const m = [...messages]; while (m.length && m[0].role !== 'user') m.shift(); return m; };

// ------------------------------------------------------------------ Anthropic
async function viaAnthropic({ system, context, messages, media, schema, effort = 'low', what = 'response' }) {
  const msgs = startWithUser(messages).map((m, i, all) => {
    if (media && i === all.length - 1 && m.role === 'user') {
      const kind = media.mime === 'application/pdf' ? 'document' : 'image';
      return { role: 'user', content: [{ type: kind, source: { type: 'base64', media_type: media.mime, data: media.base64 } }, { type: 'text', text: m.content }] };
    }
    return m;
  });
  const res = await anthropic().messages.create({
    model: MODEL, max_tokens: 16000,
    system: [{ type: 'text', text: system }, ...(context ? [{ type: 'text', text: context, cache_control: { type: 'ephemeral' } }] : [])],
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: msgs,
  });
  if (res.stop_reason === 'refusal') throw new Error(`The model declined to process this ${what}.`);
  if (res.stop_reason === 'max_tokens') throw new Error(`The ${what} was too long for one response (max_tokens reached).`);
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error(`No text returned for ${what}.`);
  return JSON.parse(block.text);
}

// ------------------------------------------------------------------ Gemini (REST; key sent in a header, never logged)
const GEMINI_TYPES = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY' };

/** JSON Schema -> Gemini's OpenAPI-style responseSchema (nullable via `nullable`, no additionalProperties). */
export function toGeminiSchema(s) {
  const out = {};
  let type = s.type;
  if (Array.isArray(type)) { if (type.includes('null')) out.nullable = true; type = type.find((t) => t !== 'null'); }
  if (type) out.type = GEMINI_TYPES[type];
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = s.description;
  if (s.properties) { out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)])); out.propertyOrdering = Object.keys(s.properties); }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

function geminiContents({ messages, media }) {
  return startWithUser(messages).map((m, i, all) => {
    const parts = [{ text: m.content }];
    if (media && i === all.length - 1 && m.role === 'user') parts.unshift({ inlineData: { mimeType: media.mime, data: media.base64 } });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

/** POST one Gemini request body, with retry + fallback across models within one time budget. Returns the first candidate. */
async function fetchGeminiCandidate(body, what) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  // Google's models are sometimes overloaded (503/429). Try the primary model, then fall back to others, within one overall
  // time budget (Vercel functions stop at 60s). Override the fallbacks with CL_GEMINI_FALLBACKS="model-a,model-b".
  const fallbacks = (process.env.CL_GEMINI_FALLBACKS ?? 'gemini-3.6-flash,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean);
  const models = [MODEL, ...fallbacks.filter((m) => m !== MODEL)];
  const deadline = Date.now() + 50000;
  let data, lastErr;
  outer: for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 4000) break outer;
      let res;
      try { res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(Math.min(left, 40000)) }); }
      catch (e) { lastErr = `${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; break; } // try the next model
      data = await res.json().catch(() => null);
      if (res.ok) break outer;
      const msg = data?.error?.message || res.statusText;
      if ([429, 500, 503, 404].includes(res.status)) { // overloaded, quota-exhausted, or retired model: retry once, then move on
        lastErr = `${model}: ${res.status} ${msg}`; data = null;
        if (res.status === 404) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const hint = res.status === 400 || res.status === 403 ? ' Check that GEMINI_API_KEY is a valid Google AI Studio key.' : '';
      const e = new Error(`Gemini API error ${res.status}: ${msg}.${hint}`); e.status = res.status; throw e;
    }
  }
  if (!data) { const e = new Error(`Gemini is busy right now, so this ${what} could not be completed. Please try again in a minute. (${String(lastErr).slice(0, 160)})`); e.status = 429; throw e; }
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`Gemini returned no answer for this ${what}${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}.`);
  if (cand.finishReason === 'MAX_TOKENS') throw new Error(`The ${what} was too long for one response (max tokens reached).`);
  return cand;
}

function geminiJsonText(cand, what) {
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned an empty ${what}${cand.finishReason ? ` (${cand.finishReason})` : ''}.`);
  try { return JSON.parse(text); } catch { throw new Error(`Gemini returned malformed JSON for this ${what}. Try again.`); }
}

async function viaGemini({ system, context, messages, media, schema, what = 'response' }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: context ? `${system}\n\n${context}` : system }] }, contents: geminiContents({ messages, media }),
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema), temperature: 0.1, maxOutputTokens: 16000 },
  });
  return geminiJsonText(await fetchGeminiCandidate(body, what), what);
}

/**
 * Gemini only, and only when CL_WEB_SEARCH=true (see server/chat.js): same as viaGemini, but also gives the
 * model Google's live search tool (`google_search`) and asks for structured JSON in the same call, so the
 * model decides per-question whether it needs to search — no separate classifier. Requires a Google Cloud
 * project with Search Grounding billing enabled; without it every call here fails (typically 429
 * RESOURCE_EXHAUSTED) and the caller is expected to fall back to the plain `generateJson`/`viaGemini` path.
 * Grounding sources, if any, come back as `web_citations` on the parsed result (not validated against the
 * contract's paragraphs — that's the caller's job for the `citations` field; these are external by nature).
 */
export async function generateJsonWithWebSearch({ system, context, messages, schema, what = 'response' }) {
  if (PROVIDER !== 'gemini') throw new Error('Web search is only implemented for the Gemini provider.');
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: context ? `${system}\n\n${context}` : system }] }, contents: geminiContents({ messages }),
    tools: [{ google_search: {} }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema), temperature: 0.1, maxOutputTokens: 16000 },
  });
  const cand = await fetchGeminiCandidate(body, what);
  const parsed = geminiJsonText(cand, what);
  const chunks = cand.groundingMetadata?.groundingChunks || [];
  parsed.web_citations = chunks.map((c) => ({ title: c.web?.title || c.web?.uri || 'Web source', url: c.web?.uri || null })).filter((c) => c.url).slice(0, 6);
  parsed.searched = !!cand.groundingMetadata;
  return parsed;
}
