# Headline to Market — Implementation & Verification Plan

Derived from `info.md`. Updated at the end with actual check results.

## Stack (decided from environment inspection, per `info.md` §3)

| Concern         | Choice                                                     |
| --------------- | ---------------------------------------------------------- |
| Runtime         | Node 24 (available; no working Python in env)              |
| Language        | TypeScript, run directly via Node's type stripping         |
| Schema          | Zod v4 (discriminated union `market` / `unresolvable`)     |
| LLM API         | Anthropic Messages API by default; OpenAI-compatible fallback via env |
| HTTP            | Node built-in `http` (no framework)                        |
| Database        | `node:sqlite` (`DatabaseSync`), file-based, zero setup     |
| Tests           | `node:test` + `tsc --noEmit`                               |

Dependencies: `zod` (runtime), `typescript` (dev, type-check only).

## Architecture

```
Browser UI (public/)  ──fetch──▶  HTTP server (src/server.ts)
                                     │  POST /api/generate
                                     │  PATCH /api/drafts/:id          (edit)
                                     │  POST /api/drafts/:id/approve   (explicit approval)
                                     │  POST /api/drafts/:id/discard
                                     │  GET  /api/drafts
                                     ▼
                              src/generate.ts  (pipeline)
                              1. build prompt   (src/prompt.ts — system vs delimited user data)
                              2. call LLM       (src/llm.ts — timeout + capped retries)
                              3. JSON.parse the response text
                              4. Zod schema validation (src/schema.ts — discriminated union)
                              5. semantic checks in code (close time vs now, source, edge cases)
                              6. return typed result: market | unresolvable | error state
                                     ▼
                              src/db.ts (node:sqlite: drafts table, status pending/approved/discarded)
```

### Check-to-code map (the 10 scored checks from `info.md` §5)

1. **Schema validation before use** — `src/schema.ts` declares the Zod schema; `src/generate.ts` validates *before* any field is read or stored. No bare-parse usage anywhere.
2. **Close time vs current time in code** — `validateMarket()` compares `closeTime` to `Date.now()`; past close ⇒ validation error. Also applied on editor edits.
3. **Explicit unresolvable outcome** — `z.discriminatedUnion("outcome", [MarketDraft, UnresolvableDraft])`; unresolvable carries `reason`.
4. **Headline as delimited data** — `src/prompt.ts`: system message holds only instructions; headline/snippet go in the user message inside `<headline>…</headline>` / `<article_snippet>…</article_snippet>` tags with anti-injection guidance.
5. **Timeout** — `LLM_TIMEOUT_MS` (default 30000) via `AbortController` on every fetch.
6. **Capped retries** — `LLM_MAX_RETRIES` (default 2, finite constant); retry only transient failures; total attempts = retries + 1.
7. **Validation-failure fallback** — pipeline returns `{ ok:false, error }` envelope (never throws out of the handler); UI renders an error panel with **Retry** and **Draft manually** actions; manual path saves a still-pending draft.
8. **Explicit approval** — generation writes `status='pending'` only; `status='approved'` set only in the approve route handler, triggered by an explicit editor action. Discard is a separate action.
9. **Golden set with expected rejection** — `data/golden-set.json` with labelled cases incl. several `unresolvable`; `npm run eval` (`scripts/eval.ts`) reports per-case pass/fail vs label.
10. **No credentials in tracked files** — `.env.example` placeholders only; `.gitignore` covers `.env`, `data/*.db`, `node_modules`; test `tests/security.test.ts` scans tracked files for key patterns.

### Data model (`drafts` table)

- `id`, `created_at`, `updated_at`
- `status`: `pending` | `approved` | `discarded` (starts `pending`; nothing else is written at generation time)
- `headline`, `snippet`
- `outcome`: `market` | `unresolvable`
- `payload`: JSON of the validated Zod object
- `rejection_reason`: reason when outcome is unresolvable

### API surface

- `POST /api/generate` `{ headline, snippet? }` → `{ ok:true, draft }` or `{ ok:false, error: { kind, message } }` (HTTP 200 envelope so the UI always has a state to render; bad client input → 400)
- `PATCH /api/drafts/:id` — edit fields, re-validated in code (close time must still be future)
- `POST /api/drafts/:id/approve` — the only place `approved` is written
- `POST /api/drafts/:id/discard`
- `GET /api/drafts`

### UI states (required by constraint: draft, rejection reason, validation errors, loading, retry/manual fallback)

idle → loading → { market draft (editable form, Approve / Discard) | unresolvable panel (reason, Discard) | error panel (message + Retry + Draft manually) } + drafts list with status badges.

### Golden set (initial cases)

1. Bengaluru Metro Blue Line opening date (concrete, dated) → market
2. IMD rainfall tomorrow in Bengaluru → market
3. "Will Bengaluru traffic improve?" (the real-world bad example, vague) → unresolvable
4. "Is the new Namma Metro station art beautiful?" (subjective) → unresolvable
5. Did India win the 2011 ODI World Cup? (already settled past event) → unresolvable
6. RBI repo rate decision at next MPC meeting → market
7. "Something exciting happened in tech yesterday" (unverifiable, no entity/date) → unresolvable

## Files to create

```
info.md, plan.md, README.md
package.json, tsconfig.json, .env.example, .gitignore (extend)
src/config.ts     env loading + constants (timeout, retries)
src/schema.ts     Zod discriminated union + semantic validation (close-time-vs-now, source, edge cases)
src/prompt.ts     system prompt + delimited user message builder
src/llm.ts        provider clients (anthropic/openai-compatible), timeout, capped retries, injectable fetch
src/generate.ts   orchestration + error envelopes
src/db.ts         node:sqlite store
src/server.ts     http server + routes + static files
public/index.html, public/app.js, public/style.css
scripts/eval.ts   golden-set evaluation runner
tests/schema.test.ts, tests/prompt.test.ts, tests/generate.test.ts, tests/db.test.ts, tests/security.test.ts
data/golden-set.json
```

## Verification steps

1. `npm install`
2. `npm run typecheck` — `tsc --noEmit` clean
3. `npm test` — node:test covers:
   - valid market passes schema; missing fields fail
   - unresolvable outcome passes; wrong discriminator fails (schema rejection)
   - **past close time rejected in code** (mock LLM returns past date)
   - headline/snippet appear in user message inside delimiters, never in system message
   - timeout constant configured; a hanging mock fetch aborts within the timeout
   - failing mock fetch retried exactly `maxRetries + 1` times (cap respected)
   - malformed model output ⇒ `{ ok:false }` error state, not a thrown/uncaught error, invalid output never stored
   - generation stores `pending`; only approve route sets `approved`; discard sets `discarded`
   - golden set contains ≥1 expected `unresolvable` case
   - tracked-file credential scan passes
4. `npm run eval` — real-API run (needs key) or `LLM_PROVIDER=mock` offline smoke run; report table with pass/fail vs labels
5. Manual smoke: start server, open UI, generate from a golden headline (mock provider if no key), approve, discard, retry/manual fallback paths
6. Update this file's "Results" section with what passed/failed and remaining limitations.

## Results

Verified on 2026-10-18 (Node v24.20.0, Windows):

| Step                                   | Result |
| -------------------------------------- | ------ |
| `npm install`                          | clean  |
| `npm run typecheck` (`tsc --noEmit`)   | 0 errors |
| `npm test`                             | 30/30 pass |
| `npm run eval -- --mock`               | 7/7 golden cases match labels |
| Server smoke (mock provider, port 8791)| generate → market draft (`pending`) ✔ · approve → `approved` (live) ✔ · vague headline → `unresolvable` + reason ✔ · empty headline → validation error ✔ · manual draft → `pending` ✔ · drafts list ✔ · UI served HTTP 200 ✔ |

### Issues found during final verification and fixed

1. `src/llm.ts` had a type error (`Pick<LlmDraft, 'reason'>` on a discriminated union) — replaced with the `UnresolvableDraft` branch type.
2. The model-call timeout relied entirely on `fetch` honouring the abort signal; a stalled connection could hang forever. The timeout is now enforced in code via `Promise.race` against a timer, and the abort signal is still forwarded (check 5 now genuinely holds).
3. `npm test` used `node --test tests/`, which the Node test runner could not resolve on Windows — switched to the glob form `node --test "tests/*.test.ts"`.
4. One test asserted inside un-awaited `.then()` chains (failures would have been swallowed) — rewritten with `async/await`.
5. The check-10 credential scan had a crude `[A-Z0-9]{32}` catch-all that would false-positive on `package-lock.json` integrity hashes — replaced with targeted provider-prefix patterns (`sk-…`, `ghp_…`, `github_pat_…`, `xox…`).

### Remaining limitations

- The golden-set eval is deterministic with `LLM_PROVIDER=mock`; a live run needs an API key (`npm run eval` without `--mock`).
- The mock provider uses keyword heuristics (it is test/demo infrastructure, not product logic); real-provider behaviour follows the same prompt/schema path.
- Approval makes a draft `approved`/live in the local store only — there is no external market-publishing integration in the MVP.
