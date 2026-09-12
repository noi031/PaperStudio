// 行内批注仓储：notes 表读写（highlight / comment）。
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { NoteRecord, NoteType } from '../shared/types.js';

interface NoteRow {
  id: string;
  paper_id: string;
  page: number | null;
  type: string;
  text: string;
  content: string;
  author: string;
  created_at: number;
}

function toRecord(r: NoteRow): NoteRecord {
  return {
    id: r.id,
    paperId: r.paper_id,
    page: r.page ?? 1,
    type: (r.type === 'comment' ? 'comment' : 'highlight') as NoteType,
    text: r.text,
    content: r.content,
    author: r.author,
    createdAt: r.created_at,
  };
}

export class NoteRepo {
  constructor(private readonly db: Database) {}

  listByPaper(paperId: string): NoteRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE paper_id = ? ORDER BY page ASC, created_at ASC')
      .all(paperId) as NoteRow[];
    return rows.map(toRecord);
  }

  insert(paperId: string, page: number, type: NoteType, text: string, content: string, author: string): NoteRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO notes (id, paper_id, page, type, anchors_json, text, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, paperId, page, type, null, text, content, author, Date.now());
    return this.get(id)!;
  }

  get(id: string): NoteRecord | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? toRecord(row) : null;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }
}
