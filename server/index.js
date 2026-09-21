// Local launcher. On Vercel the app is served by api/index.js instead (no listen, no timers).
import app from './app.js';
import { PORT, MODE, MODEL, PROVIDER } from './config.js';
import { ready, dbKind } from './db.js';
import { runReminders } from './alerts.js';

await ready;
app.listen(PORT, () => {
  console.log(`ContractLens running at http://localhost:${PORT}`);
  console.log(`  database: ${dbKind() === 'postgres' ? 'Postgres (DATABASE_URL)' : 'embedded local Postgres (PGlite) in ./data/pglite'}`);
  console.log(MODE === 'live' ? `  extraction/chat: LIVE via ${PROVIDER} (${MODEL})` : '  extraction/chat: OFFLINE demo mode (fixtures for /samples files). Set GEMINI_API_KEY or ANTHROPIC_API_KEY for live extraction.');
  if (process.env.ACCESS_PASSWORD) console.log('  access code: required');
});
runReminders().catch((e) => console.error('reminder run failed', e));
setInterval(() => runReminders().catch((e) => console.error('reminder run failed', e)), 60 * 60 * 1000).unref();
