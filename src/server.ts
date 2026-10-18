/**
 * HTTP server — thin plumbing over `App`. Serves the editor UI and the API.
 * Every handler is wrapped so nothing becomes an uncaught 500 (check 7).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app.ts';
import { DraftStore, type MarketPatch } from './db.ts';
import { LlmClient, defaultMockResponder } from './llm.ts';
import { config } from './config.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const resolved = normalize(join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

export function buildServer(app: App) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      // --- API ---
      if (path === '/api/generate' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = await app.generate({
          headline: asString(body.headline),
          snippet: asString(body.snippet),
        });
        sendJson(res, 200, result);
        return;
      }
      if (path === '/api/drafts' && req.method === 'GET') {
        sendJson(res, 200, app.list());
        return;
      }
      if (path === '/api/drafts' && req.method === 'POST') {
        // Manual-drafting fallback path (check 7).
        const body = (await readBody(req)) as Record<string, unknown>;
        const patch: MarketPatch = {};
        for (const key of ['question', 'closeTime', 'resolutionSource', 'yesCriteria', 'noCriteria'] as const) {
          const value = asString(body[key]);
          if (value !== undefined) patch[key] = value;
        }
        if (Array.isArray(body.edgeCases) && body.edgeCases.every((e) => typeof e === 'string')) {
          patch.edgeCases = body.edgeCases;
        }
        sendJson(res, 200, app.createManual({ headline: asString(body.headline), patch }));
        return;
      }
      const draftMatch = path.match(/^\/api\/drafts\/([^/]+)(?:\/(approve|discard))?$/);
      if (draftMatch) {
        const id = decodeURIComponent(draftMatch[1]);
        const action = draftMatch[2];
        if (!action && req.method === 'PATCH') {
          const body = (await readBody(req)) as Record<string, unknown>;
          const patch: MarketPatch = {};
          for (const key of ['question', 'closeTime', 'resolutionSource', 'yesCriteria', 'noCriteria'] as const) {
            const value = asString(body[key]);
            if (value !== undefined) patch[key] = value;
          }
          if (Array.isArray(body.edgeCases) && body.edgeCases.every((e) => typeof e === 'string')) {
            patch.edgeCases = body.edgeCases;
          }
          sendJson(res, 200, app.edit(id, patch));
          return;
        }
        if (action === 'approve' && req.method === 'POST') {
          sendJson(res, 200, app.approve(id));
          return;
        }
        if (action === 'discard' && req.method === 'POST') {
          sendJson(res, 200, app.discard(id));
          return;
        }
      }
      if (path.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: { kind: 'validation', message: 'Unknown API route.' } });
        return;
      }

      // --- Static UI ---
      if (req.method === 'GET') {
        await serveStatic(res, path);
        return;
      }
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      // Never leak internals or crash: defined fallback state for every failure.
      console.error(`[server] request failed: ${path}`, err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: { kind: 'llm', message: 'The request failed unexpectedly. Please retry or draft manually.' },
        });
      }
    }
  });
}

export function createAppFromConfig(dbPath: string): { app: App; store: DraftStore } {
  const store = new DraftStore(dbPath);
  const llm = new LlmClient({
    provider: config.provider,
    apiKey: config.provider === 'anthropic' ? config.anthropicApiKey : config.openaiApiKey,
    model: config.provider === 'anthropic' ? config.anthropicModel : config.openaiModel,
    baseUrl: config.openaiBaseUrl,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
    ...(config.provider === 'mock' ? { mockResponder: defaultMockResponder } : {}),
  });
  return { app: new App(store, llm), store };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const { app } = createAppFromConfig(config.dbPath);
  const server = buildServer(app);
  server.listen(config.port, () => {
    console.log(`Headline to Market — http://localhost:${config.port} (provider: ${config.provider}, timeout: ${config.llmTimeoutMs}ms, retries: ${config.llmMaxRetries})`);
    if (config.provider !== 'mock' && !config.anthropicApiKey && !config.openaiApiKey) {
      console.warn('No API key configured. Set ANTHROPIC_API_KEY in .env, or use LLM_PROVIDER=mock for an offline demo.');
    }
  });
}
