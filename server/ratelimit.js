import { q } from './db.js';
import { httpError } from './util.js';

/**
 * Fixed-window rate limiter backed by the database, so the count is shared by every serverless instance
 * (an in-memory Map resets on each cold start and is per-instance, which makes it useless on Vercel).
 * Throws a 429 once `key` has been seen more than `max` times inside `windowMs`.
 */
export async function limit(key, max, windowMs) {
  const t = Date.now();
  const [row] = await q(
    `INSERT INTO rate_limit (k, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (k) DO UPDATE SET
       n = CASE WHEN rate_limit.reset_at < ? THEN 1 ELSE rate_limit.n + 1 END,
       reset_at = CASE WHEN rate_limit.reset_at < ? THEN ? ELSE rate_limit.reset_at END
     RETURNING n`,
    [key, t + windowMs, t, t, t + windowMs]);
  if (row.n > max) throw httpError(429, 'Too many requests. Please wait a while and try again.');
}

/** Per-hour ceilings for the endpoints that cost money (override with env vars). */
export const LIMITS = {
  unlock: { max: 10, windowMs: 10 * 60 * 1000 },
  upload: { max: Number(process.env.RL_UPLOADS_PER_HOUR) || 30, windowMs: 3600 * 1000 },
  chat: { max: Number(process.env.RL_CHATS_PER_HOUR) || 120, windowMs: 3600 * 1000 },
};
