/**
 * SQLite draft store using Node's built-in `node:sqlite` — no database
 * server, no native dependencies.
 *
 * Check 8: `createPending` hardcodes status 'pending'. The string 'approved'
 * is written only by `approve()`, which is invoked solely by the explicit
 * editor-approval route. The generation path can never publish.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmDraft } from './schema.ts';

export type DraftStatus = 'pending' | 'approved' | 'discarded';

export interface DraftRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: DraftStatus;
  headline: string;
  snippet: string | null;
  outcome: 'market' | 'unresolvable';
  payload: LlmDraft;
}

export interface CreateDraftInput {
  headline: string;
  snippet?: string;
  payload: LlmDraft;
}

export interface MarketPatch {
  question?: string;
  closeTime?: string;
  resolutionSource?: string;
  yesCriteria?: string;
  noCriteria?: string;
  edgeCases?: string[];
}

interface DraftRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  headline: string;
  snippet: string | null;
  outcome: string;
  payload: string;
}

function rowToRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as DraftStatus,
    headline: row.headline,
    snippet: row.snippet,
    outcome: row.outcome as 'market' | 'unresolvable',
    payload: JSON.parse(row.payload) as LlmDraft,
  };
}

export class DraftStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        headline    TEXT NOT NULL,
        snippet     TEXT,
        outcome     TEXT NOT NULL,
        payload     TEXT NOT NULL
      );
    `);
  }

  /** Generation may only ever create unpublished, pending drafts (check 8). */
  createPending(input: CreateDraftInput): DraftRecord {
    const now = new Date().toISOString();
    const record: DraftRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      headline: input.headline,
      snippet: input.snippet?.trim() ? input.snippet.trim() : null,
      outcome: input.payload.outcome,
      payload: input.payload,
    };
    this.db
      .prepare(
        `INSERT INTO drafts (id, created_at, updated_at, status, headline, snippet, outcome, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.createdAt,
        record.updatedAt,
        record.status,
        record.headline,
        record.snippet,
        record.outcome,
        JSON.stringify(record.payload),
      );
    return record;
  }

  list(): DraftRecord[] {
    const rows = this.db.prepare(`SELECT * FROM drafts ORDER BY created_at DESC`).all() as unknown as DraftRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): DraftRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as DraftRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Edit fields of a pending market draft. Returns undefined if not found. */
  update(id: string, patch: MarketPatch): DraftRecord | undefined {
    const record = this.get(id);
    if (!record || record.outcome !== 'market') return undefined;
    const payload = record.payload as Extract<LlmDraft, { outcome: 'market' }>;
    const updated: Extract<LlmDraft, { outcome: 'market' }> = {
      ...payload,
      ...(patch.question !== undefined ? { question: patch.question } : {}),
      ...(patch.closeTime !== undefined ? { closeTime: patch.closeTime } : {}),
      ...(patch.resolutionSource !== undefined ? { resolutionSource: patch.resolutionSource } : {}),
      ...(patch.yesCriteria !== undefined ? { yesCriteria: patch.yesCriteria } : {}),
      ...(patch.noCriteria !== undefined ? { noCriteria: patch.noCriteria } : {}),
      ...(patch.edgeCases !== undefined ? { edgeCases: patch.edgeCases } : {}),
    };
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE drafts SET payload = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(updated), now, id);
    return this.get(id);
  }

  /** The ONLY place status becomes 'approved' (check 8). */
  approve(id: string): DraftRecord | undefined {
    const record = this.get(id);
    if (!record || record.outcome !== 'market') return undefined;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?`).run(now, id);
    return this.get(id);
  }

  discard(id: string): DraftRecord | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?`).run(now, id);
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}
