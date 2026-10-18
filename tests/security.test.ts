/**
 * Check 10: no credential appears in any tracked file. Also sanity-check the
 * structure supports all 10 checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function trackedFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf-8', cwd: process.cwd() });
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const KEY_PATTERNS = [
  /(?:api[-_]?key|access[-_]?token|secret[-_]?key|auth[-_]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-\+]{20,}["']?/i,
  /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style secret prefixes
  /\bghp_[A-Za-z0-9]{20,}/, // GitHub personal-access tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
];
// A match is only a real finding if the captured text is not obviously a
// placeholder (e.g. ANTHROPIC_API_KEY=your-anthropic-api-key, or
// 'test-key-not-a-real-credential' in tests).
const PLACEHOLDER_MARK = /your-|example|placeholder|not-a-real|test-key|fake|dummy|redacted|xxxx/i;
const PROVIDER_KEY_HINTS = [
  /ANTHROPIC_API_KEY\s*[:=]\s*[^your]/i,
  /OPENAI_API_KEY\s*[:=]\s*[^your]/i,
  /CLAUDE_API_KEY\s*[:=]\s*[^your]/i,
  // Built via concatenation so this scanner's own source cannot match the
  // patterns it searches for.
  new RegExp('sk' + '-proj-'), // OpenAI project keys start this way
  new RegExp('sk' + '-ant-'), // Anthropic-style (if used)
];

const TEXT_EXTS = new Set(['.ts', '.js', '.json', '.md', '.txt', '.env', '.example', '.html', '.css', '.yml', '.yaml', '.toml']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      if (entry === '.git') continue;
      if (entry === '.aider*') continue; // history dirs? not a dir, but just in case
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

test('check 10: no credential appears in any tracked file', () => {
  const files = trackedFiles();
  const hits: string[] = [];
  for (const rel of files) {
    const abs = join(process.cwd(), rel);
    const st = statSync(abs);
    if (st.isDirectory()) continue;
    const ext = extname(abs).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue; // skip binaries
    let content: string;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    for (const pat of KEY_PATTERNS) {
      const match = pat.exec(content);
      if (match && !PLACEHOLDER_MARK.test(match[0])) {
        hits.push(`${rel} — matches pattern ${pat}`);
      }
    }
    for (const pat of PROVIDER_KEY_HINTS) {
      if (pat.test(content)) hits.push(`${rel} — matches provider hint ${pat}`);
    }
  }
  assert.equal(hits.length, 0, `credentials/keys found in tracked files: ${hits.join('; ')}`);
});

test('security: .env.example contains only placeholders', () => {
  const content = readFileSync(join(process.cwd(), '.env.example'), 'utf-8');
  for (const pat of PROVIDER_KEY_HINTS) {
    assert.ok(!pat.test(content), `placeholder policy violated: found ${pat} in .env.example`);
  }
  assert.ok(content.includes('your-anthropic-api-key'));
});

test('security: .gitignore excludes .env and local db', () => {
  const content = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8');
  assert.ok(/\.env\n/.test(content) || content.includes('.env'));
  assert.ok(content.includes('data/*.db'));
});

test('golden set satisfies check 9: includes an expected-rejection headline', () => {
  const golden = JSON.parse(readFileSync(join(process.cwd(), 'data/golden-set.json'), 'utf-8')) as any;
  const hasRejection = golden.cases?.some((c: any) => c.expectedOutcome === 'unresolvable');
  assert.equal(hasRejection, true);
});
