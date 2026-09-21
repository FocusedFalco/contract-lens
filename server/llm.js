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

async function viaGemini({ system, context, messages, media, schema, what = 'response' }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const contents = startWithUser(messages).map((m, i, all) => {
    const parts = [{ text: m.content }];
    if (media && i === all.length - 1 && m.role === 'user') parts.unshift({ inlineData: { mimeType: media.mime, data: media.base64 } });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: context ? `${system}\n\n${context}` : system }] }, contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema), temperature: 0.1, maxOutputTokens: 16000 },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  let data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(55000) });
    data = await res.json().catch(() => null);
    if (res.ok) break;
    if ([429, 500, 503].includes(res.status) && attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; } // transient overload
    const hint = res.status === 400 || res.status === 403 ? ' Check that GEMINI_API_KEY is a valid Google AI Studio key.' : '';
    throw new Error(`Gemini API error ${res.status}: ${data?.error?.message || res.statusText}.${hint}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`Gemini returned no answer for this ${what}${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}.`);
  if (cand.finishReason === 'MAX_TOKENS') throw new Error(`The ${what} was too long for one response (max tokens reached).`);
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned an empty ${what}${cand.finishReason ? ` (${cand.finishReason})` : ''}.`);
  try { return JSON.parse(text); } catch { throw new Error(`Gemini returned malformed JSON for this ${what}. Try again.`); }
}
