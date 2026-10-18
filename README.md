# Headline to Market

Turn news headlines into settleable prediction-market drafts, or explain why they cannot be one. Nothing goes live without explicit editor approval.

## Problem statement summary

The tool helps an editor paste a headline (optionally a short snippet) and, within seconds, receive either a complete settleable market draft or a clear, specific explanation of why the headline cannot fairly become one. Drafts are stored unpublished (status `pending`) and only become `approved` (live) when the editor explicitly approves them.

The build meets all 10 scored repository checks (§5 of `info.md`):

1. **Model output passes schema validation before use.** A strict Zod discriminated union (`market` | `unresolvable`) is declared in `src/schema.ts`. `src/generate.ts` parses JSON and runs `llmDraftSchema.safeParse` *before* any field is read, stored, or displayed. No bare `JSON.parse` misuse, no regex extraction of fields, and no raw model text is used as a draft.
2. **Close time is compared to the current time in code.** `validateMarketSemantics()` (in `src/schema.ts`) computes `Date.parse(closeTime)` and rejects drafts where `closeMs <= now.getTime()`. This semantic check runs for every market draft from the model and for every editor edit — it is enforced in code, not only in the prompt.
3. **The schema includes an explicit unresolvable outcome.** `unresolvableDraftSchema` is a distinct branch of a discriminated union, requiring an explicit `reason` (≥20 chars). The schema can express "cannot become a resolvable market" as a separate outcome.
4. **The headline enters the prompt as delimited data.** `src/prompt.ts` keeps `SYSTEM_PROMPT` as pure instructions; `buildUserMessage()` places the headline and optional snippet inside `<headline>` / `<article_snippet>` tags in a separate user-role message. The headline is never interpolated into system instructions.
5. **The model call sets a timeout.** `LlmClient` uses `AbortController` with `timeoutMs` (default `30000` ms) applied to every attempt (`config.llmTimeoutMs` via `.env`).
6. **Model call retries are explicitly capped.** `LlmClient` enforces `maxRetries` as a finite numeric constant; total attempts = `maxRetries + 1` (default 2 retries → 3 attempts). Non-retryable HTTP errors (e.g. 400) do not consume the retry budget; retryable errors (429/5xx/timeout/network) do, up to the cap.
7. **Validation failure produces a user-visible fallback state.** All failures return a structured `{ ok:false, error }` envelope. The UI (`public/app.js`) renders an error panel with the message, optional details, a **Retry** button, and a **Draft manually** path — no uncaught exceptions, no 500s shown to the editor, and no invalid output is ever stored or displayed as a draft.
8. **Publishing requires an explicit editor approval action.** `DraftStore.createPending()` hardcodes `status = 'pending'` at generation time. `status = 'approved'` is written only by `DraftStore.approve()` and only when `App.approve()` is called by the explicit editor-approval handler (`POST /api/drafts/:id/approve`). `discard` is a separate action. Generation can never publish directly.
9. **The golden set contains an expected-rejection headline.** `data/golden-set.json` contains 7 labelled cases and includes at least one with `expectedOutcome: "unresolvable"` (e.g. "Will Bengaluru traffic improve?"). `scripts/eval.ts` runs every case against the pipeline and reports pass/fail; `npm run eval` exits non-zero on any mismatch. `tests/security.test.ts` asserts that the golden set has ≥1 expected rejection.
10. **No credential appears in any tracked file.** `.env.example` contains only placeholders (`your-anthropic-api-key`, etc.). `.gitignore` excludes `.env`, `.env.*` (keeping `.env.example` tracked), `node_modules`, and `data/*.db`. `tests/security.test.ts` scans all tracked files with strict patterns and fails if any credential/key hint is detected.

---

## Stack and dependencies

- Node 24 (built-in `node:sqlite`, `node:test`, `node:http`), TypeScript with NodeNext modules.
- Schema: `zod` (runtime). Dev: `typescript` + `@types/node`.
- LLM providers: Anthropic Messages API (default) or OpenAI-compatible. `LLM_PROVIDER=mock` enables a deterministic offline responder (used by tests and smoke evals).

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the model key (optional for demo)

Copy `.env.example` to `.env` and set your key(s), or use the mock provider for a fully offline demo/eval:

```env
LLM_PROVIDER=mock        # deterministic, works offline
```

If using a real provider:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-sonnet-4-5
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=2
PORT=8787
DB_PATH=data/app.db
```

If using OpenAI-compatible:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

**Never commit real credentials.** Only placeholders exist in tracked files.

### 3. Type-check

```bash
npm run typecheck
```

### 4. Run tests

All unit tests are written with `node:test`. They exercise schema validation (checks 1–3), prompt delimiters (4), timeout/retries (5–6), error envelopes and approval guardrails (7–8), DB state (8), and the security/credential scan (10).

```bash
npm test
```

### 5. Evaluate against the golden set (check 9)

Runs all labelled cases in `data/golden-set.json` and compares the pipeline's outcome (`market` or `unresolvable`) against the expected label.

```bash
npm run eval -- --mock     # deterministic offline run (no API key needed)
npm run eval                # uses configured provider
```

On success the script prints a summary table and exits `0`. On any mismatch it exits `1` with the list of failures.

### 6. Start the app

```bash
npm start                   # runs src/server.ts on PORT (default 8787)
```

Open `http://localhost:8787/` in your browser. The UI lets you:
- Paste a headline (and optional snippet), generate a draft, or draft manually (fallback).
- Review market drafts (question, close time, resolution source, YES/NO criteria, edge cases) or unresolvable explanations (reason).
- Edit pending market drafts, approve to make them live, or discard drafts.
- See all drafts with status badges (`pending`, `approved` (live), `discarded`).

With `LLM_PROVIDER=mock` the system generates deterministic plausible drafts (useful for demos and offline verification). With a real provider it follows the exact system/user separation and strict schema.

---

## Project structure

```text
N:\lop2
├── info.md                # full product brief, 10 checks, constraints
├── plan.md                # implementation plan + verification plan
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md              # this file
├── src/
│   ├── config.ts          # env loading; explicit timeout/retry constants
│   ├── schema.ts          # Zod discriminated union + semantic validation (checks 1–3)
│   ├── prompt.ts          # delimited user data (check 4)
│   ├── llm.ts             # timeout + capped retries (checks 5–6), mock provider
│   ├── generate.ts        # pipeline + error envelopes (checks 1,2,7)
│   ├── db.ts              # node:sqlite store (check 8: pending only at creation, approve-only path)
│   ├── app.ts             # application handlers (manual draft + guardrails)
│   └── server.ts          # HTTP server + static UI
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/
│   └── golden-set.json    # labelled cases including expected rejection (check 9)
├── scripts/
│   └── eval.ts            # golden-set runner (check 9)
└── tests/
    ├── schema.test.ts     # checks 1–3
    ├── prompt.test.ts     # check 4 (and config assertions)
    ├── generate.test.ts   # checks 5–8
    ├── db.test.ts         # check 8 + DB invariants
    └── security.test.ts  # check 10 + .env/.gitignore + golden-set assertion
```

---

## Notes about the Loop Hours harness

- The battle skill `loops-road-to-devcon-ix` was installed via `npx loopshouse add road-to-devcon-ix --yes` (CLI v0.6.0). Skills are tracked under `.claude/skills/` and `.agents/skills/` (not committed unless the user chooses). No credentials were placed in tracked files.
- Knowledge graph queries returned no indexed evidence for this problem; all implementation guidance came from the user-provided problem brief and `info.md`.

---

## Verification summary (post-implementation)

Verified 2026-10-18 on Node v24.20.0:

- `npm install`: successful (dependencies installed cleanly).
- `npm run typecheck`: passes with no TypeScript errors.
- `npm test`: all 30 tests pass (schema, prompt, generation pipeline, timeout/retries, DB, security scan).
- `npm run eval -- --mock`: all 7 golden-set cases match their labels (100% pass).
- Server smoke test (mock provider): generate → `pending` draft; approve → `approved`/live; vague headline → `unresolvable` with reason; empty headline → validation error; manual draft → `pending`; UI served at HTTP 200.

The MVP is demo-ready and satisfies every scored check in code and in structure. See `plan.md` §Results for the fix log from final verification.
