// 行内批注仓储：notes 表读写（highlight / comment）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { NoteRecord, NoteType } from '../shared/types.js';

interface NoteRow {
  id: string;
  paper_id: string;
  page: number | null;
  type: string;
  text: string;
  content: string;
  color: string | null;
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
    color: r.color ?? null,
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

  insert(
    paperId: string,
    page: number,
    type: NoteType,
    text: string,
    content: string,
    author: string,
    color: string | null = null,
  ): NoteRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO notes (id, paper_id, page, type, anchors_json, text, content, color, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, paperId, page, type, null, text, content, color, author, Date.now());
    return this.get(id)!;
  }

  get(id: string): NoteRecord | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 更新批注（content/type/text/color 可改，null/undefined 表示不动）。 */
  update(
    id: string,
    patch: { content?: string | null; type?: NoteType | null; text?: string | null; color?: string | null },
  ): NoteRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    const content = patch.content !== undefined && patch.content !== null ? patch.content : cur.content;
    const type = patch.type !== undefined && patch.type !== null ? patch.type : cur.type;
    const text = patch.text !== undefined && patch.text !== null ? patch.text : cur.text;
    const color = patch.color !== undefined ? patch.color : cur.color;
    this.db
      .prepare('UPDATE notes SET content = ?, type = ?, text = ?, color = ? WHERE id = ?')
      .run(content, type, text, color, id);
    return this.get(id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }

  /** 指定论文的批注数。 */
  countByPaper(paperId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM notes WHERE paper_id = ?').get(paperId) as { c: number };
    return r.c;
  }

  /** 导出某论文全部批注为 JSON 文件（分享/备份），返回文件路径。 */
  exportJson(paperId: string, paperTitle: string, externalId: string | null, dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const safe = (externalId || paperId).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'notes';
    const filePath = path.join(dir, `批注-${safe}.json`);
    const notes = this.listByPaper(paperId).map((n) => ({
      page: n.page,
      type: n.type,
      text: n.text,
      content: n.content,
      color: n.color,
      author: n.author,
      createdAt: n.createdAt,
    }));
    const payload = {
      app: 'PaperStudio',
      kind: 'notes',
      version: 1,
      paper: { id: paperId, title: paperTitle, externalId: externalId ?? null },
      notes,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  }

  /** 从 JSON 文件内容导入批注到指定论文，返回导入条数。 */
  importJson(json: string, targetPaperId: string): number {
    const payload = JSON.parse(json) as {
      app?: string;
      kind?: string;
      notes?: Array<{
        page?: unknown;
        type?: unknown;
        text?: unknown;
        content?: unknown;
        color?: unknown;
        author?: unknown;
        createdAt?: unknown;
      }>;
    };
    const { notes: fileNotes } = payload;
    if (payload.app !== 'PaperStudio' || payload.kind !== 'notes' || !Array.isArray(fileNotes)) {
      throw new Error('不是有效的 PaperStudio 批注导出文件');
    }
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO notes (id, paper_id, page, type, anchors_json, text, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let imported = 0;
    const tx = this.db.transaction(() => {
      for (const n of fileNotes) {
        const type: NoteType = n.type === 'comment' ? 'comment' : 'highlight';
        const text = String(n.text ?? '').trim();
        if (!text) continue;
        stmt.run(
          randomUUID(),
          targetPaperId,
          Number(n.page) || 1,
          type,
          null,
          text,
          String(n.content ?? '').trim(),
          typeof n.color === 'string' && n.color ? n.color : null,
          String(n.author ?? 'me') || 'me',
          Number(n.createdAt) || now,
        );
        imported += 1;
      }
    });
    tx();
    return imported;
  }
}
