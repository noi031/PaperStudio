// SQLite schema 与初始化（better-sqlite3，同步）。
// 设计稿 7 表 + settings + agent_sessions（助手页会话与 dsh 会话的映射）。
import Database from 'better-sqlite3';
import type { PaperSettings } from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors_json TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT,
  abstract TEXT,
  source TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  pdf_url TEXT,
  pdf_path TEXT,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  page INTEGER,
  type TEXT NOT NULL CHECK (type IN ('highlight','underline','comment','review')),
  anchors_json TEXT,
  text TEXT NOT NULL,
  content TEXT,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('selected','full')),
  content TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  page INTEGER,
  anchor_json TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  author TEXT NOT NULL,
  ai_feedback TEXT,
  human_rebuttal TEXT,
  ai_response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS directions (
  id TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  outline_json TEXT NOT NULL DEFAULT '[]',
  sections_json TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL DEFAULT 'tex',
  exported_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presentations (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  outline_json TEXT NOT NULL DEFAULT '[]',
  slides_json TEXT NOT NULL DEFAULT '[]',
  pptx_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_paper ON notes(paper_id);
CREATE INDEX IF NOT EXISTS idx_reviews_paper ON reviews(paper_id);
CREATE INDEX IF NOT EXISTS idx_summaries_paper ON summaries(paper_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id);
`;

export class Db {
  private db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 幂等迁移：老库缺列时补齐。 */
  private migrate(): void {
    const hasCol = (table: string, col: string): boolean => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === col);
    };
    if (!hasCol('papers', 'pdf_url')) {
      this.db.exec('ALTER TABLE papers ADD COLUMN pdf_url TEXT');
    }
    if (!hasCol('drafts', 'paper_id')) {
      this.db.exec('ALTER TABLE drafts ADD COLUMN paper_id TEXT');
    }
    if (!hasCol('presentations', 'title')) {
      this.db.exec("ALTER TABLE presentations ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
    if (!hasCol('notes', 'content')) {
      this.db.exec('ALTER TABLE notes ADD COLUMN content TEXT');
    }
    if (!hasCol('drafts', 'reference_ids_json')) {
      this.db.exec("ALTER TABLE drafts ADD COLUMN reference_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  get raw(): Database.Database {
    return this.db;
  }

  ping(): string {
    const r = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return r.ok === 1 ? 'ok' : 'bad';
  }

  // ── settings ────────────────────────────────────────────────
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getSettings(): PaperSettings {
    const out = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    for (const { key, value } of rows) {
      const k = key as keyof PaperSettings;
      if (k in out) {
        const cur = out[k];
        if (typeof cur === 'number') out[k] = Number(value) as never;
        else if (typeof cur === 'boolean') out[k] = (value === 'true') as never;
        else out[k] = value as never;
      }
    }
    return out;
  }

  saveSettings(patch: Partial<PaperSettings>): PaperSettings {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) this.setSetting(k, String(v));
    }
    return this.getSettings();
  }

  close(): void {
    this.db.close();
  }
}

export function openDb(filename: string): Db {
  return new Db(filename);
}
