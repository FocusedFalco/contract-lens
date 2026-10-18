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
| `GEMINI_CHAT_API_KEY` | Optional. A separate Gemini key used only by the chatbot (e.g. separate quota/billing from extraction). `GEMINI_API_KEY` always reads/extracts the document; chat uses this one if set, else falls back to `GEMINI_API_KEY` too. |
| `CL_GEMINI_MODEL` | Default `gemini-flash-latest` (an alias for the current Flash model). Claude default: `claude-opus-5` via `CL_MODEL`. |
| `CL_WEB_SEARCH` | Chatbot only, Gemini only, off by default. Set to `true` to let the chatbot use live Google Search for questions the contract can't answer (e.g. "is this penalty typical?"), clearly labelled apart from the contract's own citations. Needs Search Grounding billing enabled on the Google Cloud project — a paid, per-request feature. Without it every attempt fails and the chatbot silently falls back to its normal contract-only answer, so it's always safe to leave on. |
| `DATABASE_URL` | A Postgres connection string (Supabase, Neon…). Blank = an embedded local Postgres (PGlite) in `./data/pglite`. |
| `ACCESS_PASSWORD` | There are no accounts. Visitors must enter this code once. **Required on any public host** (Vercel / `NODE_ENV=production`): if it's missing there, the API refuses to serve anything. Use 12+ random characters. |
| `SESSION_SECRET` | Recommended. 32+ random bytes used to sign the browser cookie (7-day expiry) so it can never be used to guess the access code. |
| `DATABASE_CA` | Recommended with Supabase: its CA certificate (Dashboard → Database → SSL Configuration), so the app verifies the database's identity instead of only encrypting the link. |
| `CL_MASK_PII` | Optional (`true`): hide ID-number, PAN, email and phone shaped values from the AI provider. Off by default because it can also hide legitimate long numbers. |
| `RL_UPLOADS_PER_HOUR`, `RL_CHATS_PER_HOUR` | Per-client ceilings on the endpoints that cost money (defaults 30 and 120). |
| `ALERT_WEBHOOK_URL` | Optional: POST active reminders to a webhook. |

`.env` is git-ignored; never commit it.

## Deploy to Vercel + Supabase

1. Push this repo to GitHub and import it in Vercel (framework: Other; `vercel.json` handles the rest).
2. Vercel → Settings → Environment Variables (type **Secret**, environment **Production**):
   - `DATABASE_URL` — Supabase **Transaction pooler** string (Connect → Transaction pooler, port 6543). Vercel cannot reach the IPv6-only direct host. Percent-encode special characters in the password.
   - `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`), and optionally `GEMINI_CHAT_API_KEY`
   - `ACCESS_PASSWORD` (**mandatory**), `SESSION_SECRET`, and ideally `DATABASE_CA`
3. Redeploy. Tables are created automatically on first request.

How it differs from local: the whole Express app runs as one serverless function (`api/index.js`); extraction happens inside the upload request (functions stop after responding); uploaded PDFs are stored in Postgres (`bytea`); reminders are checked on dashboard load (no background timer). Vercel limits request bodies to ~4.5 MB, so larger uploads fail there.

## Try it
Open the app → **Get started**. Upload a file from **Upload → Try a sample** (or run `npm run seed:demo` with the server up to load mock contracts). The Nimbus pair demonstrates vendor merge; the SPCB consent has a low-confidence fee field; the MSA is full of risky clauses. Sample PDFs live in `public/samples`; regenerate them (and the offline results in `samples/fixtures`) with `npm run samples`.

## Where the PRD lives
| PRD | Implementation |
|---|---|
| Extraction, confidence, citations | `server/extract.js` (schema-constrained output from `server/llm.js`; citations validated against real paragraph IDs) |
| Mandatory review | `POST /api/contracts/:id/confirm` in `server/app.js` refuses to activate until every low/medium-confidence field, the expiry date, the payment terms and every flag are acknowledged (the AI's own "high confidence" never skips the two fields with real-world consequences) |
| Chat with citations, explicit uncertainty | `server/chat.js` (invalid citations dropped; low confidence forces "I'm not certain:"). Optional live web search (`CL_WEB_SEARCH=true`, Gemini only) adds a clearly separate `web_citations` source for questions the contract itself can't answer — see `server/llm.js`'s `generateJsonWithWebSearch`. |
| Vendor resolution, manual/automatic chain | `server/vendors.js` + confirm flow; mode is a setting |
| Alerts: passive + active | `server/alerts.js` (dashboard computed on load; notifications fire once per window) |
| Regulatory change | **Mocked**: 2 seeded records keyword-matched to `regulatory_class` contracts |

## Security notes
- **No accounts**: one shared workspace behind one access code. Anyone with the code sees every contract; chat history is private per browser session only. Don't use it for data that must be separated between people or organisations.
- **Database**: Row-Level Security is switched on for every table at startup and the Supabase `anon`/`authenticated` roles are revoked, so the project's public HTTP "Data API" can't read or change anything. The app itself connects directly as the table owner.
- **AI providers**: the full text of each contract (and the original image for scans) is sent to the provider. On Google's free Gemini tier that content may be used to improve Google products and be read by human reviewers; enable Cloud Billing on the project behind your key for the paid terms before uploading real personal or business documents.
- **Prompt injection**: contract text is untrusted. It is sent in a fenced user turn (never the system prompt), tags inside it are neutralised, and the model is told to treat it as data. The AI's output is schema-constrained, citations are checked against real paragraphs, amounts are checked against the cited text, and a human must confirm before anything becomes active. This reduces the risk; it cannot remove it.
- **Rotate secrets** that were ever pasted into a chat, ticket or screenshot (database password, API keys).

## Test
```bash
CL_MODE=offline CL_PGLITE_DIR=/tmp/cl-pg PORT=3299 node server/index.js &
BASE=http://localhost:3299 npm test     # needs a FRESH database; runs against embedded Postgres
npm run test:security                   # starts its own throwaway servers: access gate, rate limits, fail-closed mode, error handling
```
The sample PDFs carry dates relative to when they were generated; if the expiry-alert test complains, run `npm run samples`.

## Known limits
- Live extraction/chat is verified with Gemini on one sample contract; the Anthropic path is written but not exercised. AI output can be wrong, which is why review is mandatory (e.g. Gemini computed one expiry a day earlier than the hand-made sample answer).
- Not built (Phase 2 per PRD): version diffing, cross-contract queries, full RBAC, live regulatory monitoring, per-payment reminders, renewal-notice-deadline alerts, business "create / verify and accept contracts".
- No user accounts: the shared access code is the only authentication (see Security notes).
