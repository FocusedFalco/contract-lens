import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const PORT = Number(process.env.PORT || 3210);
export const DATA_DIR = process.env.CL_DATA_DIR || path.join(ROOT, 'data');
export const FIXTURE_DIR = path.join(ROOT, 'samples', 'fixtures');

// Which AI reads contracts: "gemini" or "anthropic" (CL_PROVIDER forces one; otherwise whichever key is set, Gemini first).
const hasGemini = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const PROVIDER = process.env.CL_PROVIDER || (hasGemini ? 'gemini' : hasAnthropic ? 'anthropic' : null);
export const MODEL = PROVIDER === 'gemini' ? process.env.CL_GEMINI_MODEL || 'gemini-flash-latest' : process.env.CL_MODEL || 'claude-opus-5';

// "live" calls the provider; "offline" replays pre-computed fixtures (keyed by file sha256) so a demo
// never depends on the network. CL_MODE forces one; otherwise live iff a provider key is present.
export const MODE = process.env.CL_MODE || (PROVIDER ? 'live' : 'offline');
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ALERT_WINDOWS = [30, 15, 7];
