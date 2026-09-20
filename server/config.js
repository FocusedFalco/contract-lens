import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const PORT = Number(process.env.PORT || 3210);
export const DATA_DIR = process.env.CL_DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'contractlens.db');
export const FIXTURE_DIR = path.join(ROOT, 'samples', 'fixtures');
export const MODEL = process.env.CL_MODEL || 'claude-opus-5';

// "live" calls Claude; "offline" replays pre-computed fixtures (keyed by file sha256) so a demo
// never depends on the network. CL_MODE forces one; otherwise live iff credentials are present.
const hasCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const MODE = process.env.CL_MODE || (hasCreds ? 'live' : 'offline');

export const DEFAULT_ALERT_WINDOWS = [30, 15, 7];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
