# Headline to Market

**Turn a news headline into a prediction market that can actually be settled — or tell you, with a reason, why it can't. Nothing goes live until an editor approves it.**

Built for the [Road to Devcon 9](https://loopshouse.ai) contest, problem *"Headline to Market"*.

---

## The problem

Ananya edits the explainer desk at a Bengaluru digital newsroom that runs play-token prediction markets next to its stories. Writing a good market takes twenty minutes, and the bad ones cause chaos — an open-ended question like *"Will Bengaluru traffic improve?"* can sit unresolved for a month because nobody can say who would have won.

This tool does the drafting in seconds. Paste a headline (optionally with a snippet of the article) and get back one of two things:

1. **A complete, settleable market draft** — a precise YES/NO question, a close date and time, a *named* resolution source (e.g. "Reserve Bank of India"), concrete YES and NO criteria, and rules for the awkward edge cases (source silence at close time, delayed announcements, retracted reporting, partial completion).
2. **A clear refusal with a reason** — vague verbs, subjective judgements, already-settled past events, claims with no measurable threshold, outcomes no public source will report. The reason tells the editor *what's missing*, so she can rewrite the headline rather than publish an unresolvable market.

Every draft is stored **unpublished** and only becomes live through an explicit editor approval click.

## How it works

```
┌─────────────┐     ┌──────────────────────────────────────────────────────┐
│  Editor UI  │────▶│  HTTP server (src/server.ts)                         │
│  (public/)  │◀────│  POST /api/generate · PATCH/POST /api/drafts/...     │
└─────────────┘     └──────────────┬───────────────────────────────────────┘
                                   ▼
                     Generation pipeline (src/generate.ts)
                     1. Build prompt      — system instructions and untrusted
                                            headline data are SEPARATE
                                            (src/prompt.ts)
                     2. Call the LLM      — explicit timeout + capped retries
                                            (src/llm.ts)
                     3. Validate shape    — Zod discriminated union
                                            market | unresolvable (src/schema.ts)
                     4. Validate meaning  — close time must be in the future,
                                            source must be a named authority
                                            (code, not just prompt instructions)
                     5. Store as 'pending'— approval is a separate, explicit
                                            editor action (src/db.ts, SQLite)
```

### Design decisions worth knowing

- **Never trust the model.** Its response is parsed and validated against a strict schema before any field is read, stored, or shown. A malformed response never becomes a draft — it becomes a visible error state with *Retry* and *Draft manually* options.
- **Meaning, not just shape.** A syntactically perfect draft with a close time in the past is still rejected — in code, with the current time compared directly.
- **Prompt-injection safety.** The headline is untrusted input. It enters the prompt as delimited data (`<headline>…</headline>`) in the user message; the system prompt is a constant and never interpolates user text. Instructions smuggled inside a headline stay data.
- **The editor is not a rubber stamp.** Drafts are fully editable before approval; unresolvable outcomes explain exactly why the headline failed.
- **Deterministic offline mode.** A built-in mock provider lets you demo and run the full eval suite with no API key and no network.

## Quick start

Requires **Node 22.6+** (developed on Node 24). No database server, no build step, no framework.

```bash
npm install
npm start            # reads .env if present, otherwise Anthropic defaults
```

Open **http://localhost:8787/**, paste a headline, and click *Generate draft*.

### Connecting a model

Copy `.env.example` to `.env` and pick one:

**Any OpenAI-compatible endpoint** (OpenAI, or a local model via [Ollama](https://ollama.com)):

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key            # Ollama ignores this; any non-empty value works
OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama local — or https://api.openai.com/v1
OPENAI_MODEL=qwen2.5:3b            # or gpt-4o-mini, etc.
```

**Anthropic Claude** (default):

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-sonnet-4-5
```

**Fully offline demo** (no key, deterministic heuristics):

```env
LLM_PROVIDER=mock
```

Other knobs: `LLM_TIMEOUT_MS` (default 30000), `LLM_MAX_RETRIES` (default 2), `PORT` (default 8787), `DB_PATH` (default `data/app.db`).

> **Never commit real credentials.** `.env` is gitignored; the repo contains placeholders only.

## Using the tool

1. **Paste a headline** (and optionally a short article snippet) → **Generate draft**.
2. **Review the result:**
   - A market draft shows the question, close time, resolution source, YES/NO criteria, and edge-case rules — all editable via **Edit**.
   - A rejection shows *why* this headline can't be a fair market.
3. **Approve — go live** publishes the market (status `pending → approved`), or **Discard** throws it away. Both are explicit, separate actions.
4. The **Drafts** list at the bottom shows every draft with its status badge (`pending` / `approved` (live) / `discarded`).
5. If generation fails (model down, invalid output, past close time), you get an error panel with **Retry** and **Draft manually** — a hand-written draft passes the same validation and is still stored as `pending`.

## Proving it works on more than one headline

A labelled golden set lives in `data/golden-set.json` — 9 headlines, each tagged with its expected outcome (`market` or `unresolvable`), including deliberately hard cases: vague verbs, subjective taste, already-settled history, no measurable threshold, no reporting source.

```bash
npm run eval -- --mock    # deterministic offline run, no key needed
npm run eval              # run against your configured model
```

Runs every case through the full pipeline and compares the outcome to its label. Prints a per-case report and a summary; **exits non-zero on any mismatch**, so it works in CI.

## Tests

```bash
npm test            # 30 unit tests (node:test)
npm run typecheck   # tsc --noEmit
```

The suite covers: schema acceptance/rejection, close-time-vs-now enforcement in code, prompt delimiters and injection confinement, timeout enforcement (including a stalled connection), retry-cap enforcement, error envelopes instead of exceptions, approval-only publish transitions, DB invariants, and a credential scan over every git-tracked file.

## Project structure

```text
├── src/
│   ├── config.ts      # env loading; timeout/retry constants
│   ├── schema.ts      # Zod discriminated union + semantic validation
│   ├── prompt.ts      # system instructions vs delimited untrusted data
│   ├── llm.ts         # provider clients (Anthropic / OpenAI-compatible / mock),
│   │                  #   timeout, capped retries
│   ├── generate.ts    # pipeline + error envelopes
│   ├── db.ts          # SQLite store (node:sqlite) — drafts start 'pending'
│   ├── app.ts         # generate / edit / approve / discard handlers
│   └── server.ts      # HTTP server + static UI
├── public/            # editor UI (vanilla JS, no build step)
├── data/golden-set.json
├── scripts/eval.ts    # golden-set evaluation runner
└── tests/             # node:test suite
```

## Stack

TypeScript on Node · [Zod](https://zod.dev) for schemas · `node:sqlite` for storage · Anthropic Messages API or any OpenAI-compatible endpoint over plain `fetch` · `node:test` for tests. That's it — no framework, no database server, no build step.

## License

MIT
