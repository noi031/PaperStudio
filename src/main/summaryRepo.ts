// P3 总结仓储：summaries 表查询与写入。
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from './sqlite.js';
import type { SummaryKind, SummaryRecord } from '../shared/types.js';

interface SummaryRow {
  id: string;
  paper_id: string;
  kind: SummaryKind;
  content: string;
  model: string | null;
  created_at: number;
  md_path: string | null;
}

function toRecord(r: SummaryRow): SummaryRecord {
  return {
    id: r.id,
    paperId: r.paper_id,
    kind: r.kind,
    content: r.content,
    model: r.model,
    createdAt: r.created_at,
    mdPath: r.md_path ?? null,
  };
}

export class SummaryRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 每种总结类型（selected/full）只返回最新一条（刷新制：历史总结已被覆盖删除）。 */
  listByPaper(paperId: string): SummaryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM summaries WHERE paper_id = ? ORDER BY created_at DESC')
      .all(paperId) as SummaryRow[];
    const seen = new Set<SummaryKind>();
    const latest: SummaryRecord[] = [];
    for (const r of rows) {
      if (seen.has(r.kind)) continue;
      seen.add(r.kind);
      latest.push(toRecord(r));
    }
    return latest;
  }

  /** 覆盖式写入：每种总结类型（selected/full）只保留最新一条，插入前先删同类型旧记录。 */
  replace(
    paperId: string,
    kind: SummaryKind,
    content: string,
    model: string | null,
    mdPath: string | null = null,
  ): SummaryRecord {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM summaries WHERE paper_id = ? AND kind = ?').run(paperId, kind);
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO summaries (id, paper_id, kind, content, model, created_at, md_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, paperId, kind, content, model, Date.now(), mdPath);
      return id;
    });
    const id = tx();
    return this.get(id)!;
  }

  insert(
    paperId: string,
    kind: SummaryKind,
    content: string,
    model: string | null,
    mdPath: string | null = null,
  ): SummaryRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO summaries (id, paper_id, kind, content, model, created_at, md_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, paperId, kind, content, model, Date.now(), mdPath);
    return this.get(id)!;
  }

  get(id: string): SummaryRecord | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined;
    return row ? toRecord(row) : null;
  }
}
