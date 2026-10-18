# Headline to Market — Product Brief & Build Requirements

This file is the single source of truth for the MVP. `plan.md` derives its
implementation and verification steps from it.

---

## 1. The problem (product brief)

Ananya edits the explainer desk at a Bengaluru digital newsroom. They've started
running play-token prediction markets next to stories, and readers love them.
But writing a good market takes her twenty minutes, and the bad ones cause
chaos. "Will Bengaluru traffic improve?" sat open for a month because nobody
could say who had won.

She wants to paste a headline and get back a market that can actually be
settled: a precise question, a deadline, a named source that will decide it, and
a rule for the awkward cases. Some headlines can't become a fair market at all,
and the tool should tell her so rather than invent one. Nothing goes live until
she approves it.

### What you'll learn

- Getting structured output from an LLM, and why you still don't trust it
- Validating meaning, not just shape
- Keeping untrusted text away from your instructions
- Building a small eval set that tells you whether the tool works

### What to do

- Accept a news headline, optionally with a short snippet of the article.
- Use an LLM to draft a market: the question, a close date and time, the
  resolution source, what counts as YES, and how edge cases resolve.
- Deal with headlines that can't become a fair, resolvable market.
- Give an editor a way to review, edit, approve, or discard a draft.
- Show that the tool works on more headlines than the one you demo with.

**Deliverable.** A public GitHub repo containing the tool's source, your test
headlines, and a README explaining how to run it.

**Acceptance criteria.** An editor pastes a headline and, within seconds, gets
either a market she'd be comfortable settling or a clear explanation of why this
headline can't be one.

**Scoring.** 10 scored test cases · 80 points read straight off the code ·
20 points from judgment.

---

## 2. What the tool does (functional requirements)

- Accept a news headline and optionally a short article snippet.
- Ask an LLM to draft either:
  a. a complete, settleable market, or
  b. an explicit unresolvable result with a clear reason.
- A complete draft includes:
  - precise question
  - close date and time
  - named resolution source
  - what counts as YES (and make NO unambiguous)
  - edge-case resolution rules
- Let an editor review, edit, approve, or discard a draft.
- Keep generated drafts unpublished until the editor explicitly approves them.
- Include a labelled set of test headlines, including at least one expected
  rejection.
- Include a README explaining setup and how to run the app.

---

## 3. Stack guidance (from the contest brief)

- TypeScript or Python
- Claude API (or any LLM API)
- Zod or Pydantic
- SQLite or Postgres

Choose the simplest reliable stack supported by the existing folder and the
available environment. SQLite is acceptable; do not add Postgres unless the
project already uses it or there is a concrete need. Keep the database setup
simple and runnable locally.

**Environment decision (made in step 1 of the build):** the target folder has
Node v24.20.0 and no working Python, so the stack is **TypeScript on Node 24**
using: Zod for schemas, `node:sqlite` (built into Node) for storage, the
Anthropic Messages API (with an OpenAI-compatible fallback) over plain `fetch`,
and `node:test` for tests. No database server, no framework required.

---

## 4. Loop Hours battle harness instructions

- Install the battle skill in the project directory with:
  `npx loopshouse add road-to-devcon-ix`
- It requires Node 20.12+ (22 LTS recommended); sign-in opens in a browser.
- Knowledge graph query:
  `loops knowledge query --event road-to-devcon-ix --problem headline-to-market -q "<question>"`
- Once the skill is installed, ask the coding agent questions about "Headline
  to Market" in plain English.

First check whether this skill is already installed. If not, install it only if
the CLI is available and sign-in can proceed interactively; otherwise document
that setup step without blocking the MVP. Do not include credentials in files.

**Build-time status:** the CLI (`loopshouse` v0.6.0 via npx) was available and
already authenticated, so `npx loopshouse add road-to-devcon-ix --yes` was run
successfully; it installed `.claude/skills/loops-road-to-devcon-ix/SKILL.md` and
`.agents/skills/loops-road-to-devcon-ix/SKILL.md`. No credentials were written
into any tracked file (the CLI keeps auth state outside the repo). Knowledge
graph queries for this problem currently return no indexed evidence.

---

## 5. The 10 scored repository checks (80 points) — preserve exactly

Each check is answered by reading the repo you submit — pass it, bank its points.

### 1. Model output passes schema validation before use — 8 points

- **Passes if:** The model's response is validated against a declared schema
  before any of its fields are used.
- **Fails if:** The response is used after a bare `JSON.parse` / `json.loads`,
  extracted by regex, or displayed as raw text, or no model call exists.

### 2. Close time is compared to the current time in code — 10 points

- **Passes if:** Code rejects or flags a draft whose close time is not in the
  future.
- **Fails if:** No code compares the close time to the current time; any such
  constraint exists only as an instruction in the prompt.

### 3. The schema includes an explicit unresolvable outcome — 16 points

- **Passes if:** The schema can express "this headline cannot become a
  resolvable market" as a distinct outcome carrying a reason.
- **Fails if:** The schema can only express a complete market draft, so every
  response must be a market.

### 4. The headline enters the prompt as delimited data — 10 points

- **Passes if:** The headline is placed in user-role content inside explicit
  delimiters (or as a separate structured field), with instructions held
  separately from it.
- **Fails if:** The headline is interpolated into the system prompt or directly
  into instruction text without delimiters.

### 5. The model call sets a timeout — 5 points

- **Passes if:** A timeout is explicitly set on the model call.
- **Fails if:** No timeout is set anywhere on the model call.

### 6. Model call retries are explicitly capped — 5 points

- **Passes if:** Retries are configured explicitly with a finite numeric cap.
- **Fails if:** There is no explicit retry configuration, or a retry loop has no
  numeric cap.

### 7. Validation failure produces a user-visible fallback state — 8 points

- **Passes if:** A failed validation leads to a defined state shown to the
  editor (an error message, "draft manually", or a retry option).
- **Fails if:** A validation failure throws uncaught, returns a 500, or shows
  the invalid output as a draft, or no validation-failure branch exists.

### 8. Publishing requires an explicit editor approval action — 6 points

- **Passes if:** The published / live status is set only in a handler triggered
  by an explicit editor approval action.
- **Fails if:** The generation path writes drafts as published / live directly,
  or no approval or publish step exists.

### 9. The golden set contains an expected-rejection headline — 7 points

- **Passes if:** The repo contains a set of labelled headline cases, at least
  one of which expects the unresolvable outcome.
- **Fails if:** No golden set exists, or no case is labelled as an expected
  rejection.

### 10. No credential appears in any tracked file — 5 points

- **Passes if:** No credential, key, or authenticated URL appears in any tracked
  file; example env files contain only placeholders.
- **Fails if:** Any credential, key, or authenticated URL appears in a tracked
  file.

---

## 6. Implementation constraints (from the build brief)

- Use a discriminated union or equivalent schema for `market` vs `unresolvable`.
- Validate all required market fields, close-time validity, source clarity, and
  nonempty edge-case rules.
- Store drafts as pending/unpublished. Approval and discard must be separate
  explicit actions.
- The UI should make the market draft, rejection reason, validation errors,
  loading state, and retry/manual fallback clear.
- Use sensible safe handling for untrusted headline/snippet content; do not
  treat it as instructions.
- Keep the code small and demo-ready. Include seed/golden-set data and a README.
- Add tests or an evaluation script that exercises resolvable and
  expected-unresolvable headlines, schema rejection, past close dates, and
  approval behavior.
- Never place API keys in source, README examples, test fixtures, screenshots,
  or logs. Read the model key from an environment variable and provide only a
  placeholder in `.env.example`.

---

## 7. Golden set requirements

- Labelled headline cases stored in the repository (`data/golden-set.json`),
  each with an expected outcome: `market` or `unresolvable`.
- At least one case labelled `unresolvable` (expected rejection).
- A runnable evaluation script (`npm run eval`) that generates a draft for each
  case and reports per-case pass/fail against the label, with a summary and a
  non-zero exit code on mismatch.
