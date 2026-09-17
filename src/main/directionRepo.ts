// P5 方向建议仓储：directions 表读写。
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from './sqlite.js';
import type { DirectionRecord, DirectionSuggestion } from '../shared/types.js';

interface DirectionRow {
  id: string;
  context: string;
  suggestions_json: string;
  status: string;
  created_at: number;
}

function toRecord(r: DirectionRow): DirectionRecord {
  return {
    id: r.id,
    context: r.context,
    suggestions: JSON.parse(r.suggestions_json) as DirectionSuggestion[],
    status: r.status,
    createdAt: r.created_at,
  };
}

export class DirectionRepo {
  constructor(private readonly db: SqliteDb) {}

  list(): DirectionRecord[] {
    const rows = this.db.prepare('SELECT * FROM directions ORDER BY created_at DESC').all() as DirectionRow[];
    return rows.map(toRecord);
  }

  get(id: string): DirectionRecord | null {
    const row = this.db.prepare('SELECT * FROM directions WHERE id = ?').get(id) as DirectionRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(context: string, suggestions: DirectionSuggestion[]): DirectionRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO directions (id, context, suggestions_json, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, context, JSON.stringify(suggestions), 'new', Date.now());
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM directions WHERE id = ?').run(id);
  }
}
