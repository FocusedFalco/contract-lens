# ContractLens (prototype)

Upload a contract → Claude extracts terms with confidence + source citations, flags risky clauses, writes a plain-language summary → you review and confirm → chat with it, get expiry reminders, browse by vendor.

## Run

```bash
npm install
npm run samples          # (re)generate sample PDFs + offline fixtures in /samples
npm start                # http://localhost:3210
```

**Live vs offline.** With `ANTHROPIC_API_KEY` set, extraction and chat call Claude (`claude-opus-5`, override with `CL_MODEL`). Without a key the app runs in **offline demo mode**: the four `/samples` PDFs are replayed from pre-computed results (keyed by file hash) so a demo never depends on the network. Force a mode with `CL_MODE=live|offline`. Images and scanned PDFs need live mode.

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Other env: `PORT` (3210), `CL_DATA_DIR` (`./data`), `ALERT_WEBHOOK_URL` (POST active reminders).

## Try it
Open the app → **Get started** → 3-step sign-up (account → personal details → Individual or Business). Business users either create an organisation or join one with an **invite code** (Settings → Team). Everyone in an organisation has identical access; there are no uploader/viewer roles. Then upload the samples from the Upload page: the Nimbus pair demonstrates vendor merge (two spellings of one vendor); the SPCB consent has a low-confidence fee field; the MSA is full of risky clauses.

Accounts: email + password (scrypt-hashed), HttpOnly session cookie (30 days), login throttling. Prototype-grade: no email verification or password reset.

## Where the PRD lives
| PRD | Implementation |
|---|---|
| Extraction, confidence, citations | `server/extract.js` (schema-constrained Claude output; citations validated against real paragraph IDs) |
| Mandatory review | `POST /contracts/:id/confirm` in `server/index.js` refuses to activate until every low/medium field and every flag is acknowledged |
| Chat with citations, explicit uncertainty | `server/chat.js` (invalid citations dropped; low confidence forces "I'm not certain:") |
| Vendor resolution, manual/automatic chain | `server/vendors.js` + confirm flow; mode is a per-user setting |
| Alerts: passive + active | `server/alerts.js` (dashboard computed on load; notifications fire once per window, logged to `data/outbox.log`) |
| Accounts / teams | `server/auth.js`: sign-up/sign-in, personal details, Individual vs Business, org invite codes, equal access for all members |
| Regulatory change | **Mocked**: 2 seeded records keyword-matched to `regulatory_class` contracts |

## Test
```bash
CL_DATA_DIR=/tmp/cl-test PORT=3299 npm start &
BASE=http://localhost:3299 npm test     # needs a FRESH data dir
```

## Known limits
- The live Claude path has not been exercised end-to-end in this repo's build environment (no API key was available); offline mode is what the tests cover.
- Not built (Phase 2 per PRD): version diffing, cross-contract queries, full RBAC, live regulatory monitoring, per-payment reminders, renewal-notice-deadline alerts. The diagram's business "create / verify and accept contracts" flow is also not built.
- Auth is prototype-grade: no email verification, password reset or MFA.
