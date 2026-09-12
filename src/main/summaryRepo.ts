// P3 总结仓储：summaries 表查询与写入。
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { SummaryKind, SummaryRecord } from '../shared/types.js';

interface SummaryRow {
  id: string;
  paper_id: string;
  kind: SummaryKind;
  content: string;
  model: string | null;
  created_at: number;
}

function toRecord(r: SummaryRow): SummaryRecord {
  return {
    id: r.id,
    paperId: r.paper_id,
    kind: r.kind,
    content: r.content,
    model: r.model,
    createdAt: r.created_at,
  };
}

export class SummaryRepo {
  constructor(private readonly db: Database) {}

  listByPaper(paperId: string): SummaryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM summaries WHERE paper_id = ? ORDER BY created_at DESC')
      .all(paperId) as SummaryRow[];
    return rows.map(toRecord);
  }

  insert(paperId: string, kind: SummaryKind, content: string, model: string | null): SummaryRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO summaries (id, paper_id, kind, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, paperId, kind, content, model, Date.now());
    return this.get(id)!;
  }

  get(id: string): SummaryRecord | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined;
    return row ? toRecord(row) : null;
  }
}
