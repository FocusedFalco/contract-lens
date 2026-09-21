# ContractLens (prototype)

Upload a contract → AI extracts terms with confidence + source citations, flags risky clauses, writes a plain-language summary → you review and confirm → chat with it, get expiry reminders, browse by vendor.

## Run locally

```bash
npm install
cp .env.example .env     # then fill in what you need (all optional)
npm start                # http://localhost:3210
```

| Setting (`.env`) | What it does |
|---|---|
| `GEMINI_API_KEY` **or** `ANTHROPIC_API_KEY` | Turns on **live** extraction and chat for any contract (Gemini is used first if both are set; `CL_PROVIDER` forces one). Without a key the app runs in **offline demo mode**: only the four sample PDFs work, replayed from pre-computed results. |
| `CL_GEMINI_MODEL` | Default `gemini-flash-latest` (an alias for the current Flash model). Claude default: `claude-opus-5` via `CL_MODEL`. |
| `DATABASE_URL` | A Postgres connection string (Supabase, Neon…). Blank = an embedded local Postgres (PGlite) in `./data/pglite`. |
| `ACCESS_PASSWORD` | There are no accounts. If set, visitors must enter this code once. **Set it on any public deployment.** |
| `ALERT_WEBHOOK_URL` | Optional: POST active reminders to a webhook. |

`.env` is git-ignored; never commit it.

## Deploy to Vercel + Supabase

1. Push this repo to GitHub and import it in Vercel (framework: Other; `vercel.json` handles the rest).
2. Vercel → Settings → Environment Variables (type **Secret**, environment **Production**):
   - `DATABASE_URL` — Supabase **Transaction pooler** string (Connect → Transaction pooler, port 6543). Vercel cannot reach the IPv6-only direct host. Percent-encode special characters in the password.
   - `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`)
   - `ACCESS_PASSWORD`
3. Redeploy. Tables are created automatically on first request.

How it differs from local: the whole Express app runs as one serverless function (`api/index.js`); extraction happens inside the upload request (functions stop after responding); uploaded PDFs are stored in Postgres (`bytea`); reminders are checked on dashboard load (no background timer). Vercel limits request bodies to ~4.5 MB, so larger uploads fail there.

## Try it
Open the app → **Get started**. Upload a file from **Upload → Try a sample** (or run `npm run seed:demo` with the server up to load mock contracts). The Nimbus pair demonstrates vendor merge; the SPCB consent has a low-confidence fee field; the MSA is full of risky clauses. Sample PDFs live in `public/samples`; regenerate them (and the offline results in `samples/fixtures`) with `npm run samples`.

## Where the PRD lives
| PRD | Implementation |
|---|---|
| Extraction, confidence, citations | `server/extract.js` (schema-constrained output from `server/llm.js`; citations validated against real paragraph IDs) |
| Mandatory review | `POST /api/contracts/:id/confirm` in `server/app.js` refuses to activate until every low/medium field and every flag is acknowledged |
| Chat with citations, explicit uncertainty | `server/chat.js` (invalid citations dropped; low confidence forces "I'm not certain:") |
| Vendor resolution, manual/automatic chain | `server/vendors.js` + confirm flow; mode is a setting |
| Alerts: passive + active | `server/alerts.js` (dashboard computed on load; notifications fire once per window) |
| Regulatory change | **Mocked**: 2 seeded records keyword-matched to `regulatory_class` contracts |

## Test
```bash
CL_MODE=offline CL_PGLITE_DIR=/tmp/cl-pg PORT=3299 node server/index.js &
BASE=http://localhost:3299 npm test     # needs a FRESH database; runs against embedded Postgres
```

## Known limits
- Live extraction/chat is verified with Gemini on one sample contract; the Anthropic path is written but not exercised. AI output can be wrong, which is why review is mandatory (e.g. Gemini computed one expiry a day earlier than the hand-made sample answer).
- Not built (Phase 2 per PRD): version diffing, cross-contract queries, full RBAC, live regulatory monitoring, per-payment reminders, renewal-notice-deadline alerts, business "create / verify and accept contracts".
- No authentication beyond the optional shared access code.
