// P3 文献库仓储：papers 表 CRUD（better-sqlite3，同步）。
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from './sqlite.js';
import type { PaperHit, PaperRecord } from '../shared/types.js';

interface PaperRow {
  id: string;
  title: string;
  authors_json: string;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  source: string;
  external_id: string | null;
  url: string | null;
  pdf_url: string | null;
  pdf_path: string | null;
  added_at: number;
}

function toRecord(r: PaperRow): PaperRecord {
  return {
    id: r.id,
    title: r.title,
    authors: JSON.parse(r.authors_json) as string[],
    year: r.year,
    venue: r.venue,
    abstract: r.abstract,
    source: r.source,
    externalId: r.external_id ?? '',
    url: r.url,
    pdfUrl: r.pdf_url,
    pdfPath: r.pdf_path,
    addedAt: r.added_at,
  };
}

export class PaperRepo {
  constructor(private readonly db: SqliteDb) {}

  list(): PaperRecord[] {
    const rows = this.db.prepare('SELECT * FROM papers ORDER BY added_at DESC').all() as PaperRow[];
    return rows.map(toRecord);
  }

  get(id: string): PaperRecord | null {
    const row = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as PaperRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 按来源+外部 id 查重（避免重复入库）。 */
  findBySource(source: string, externalId: string): PaperRecord | null {
    const row = this.db
      .prepare('SELECT * FROM papers WHERE source = ? AND external_id = ?')
      .get(source, externalId) as PaperRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 入库检索命中；同源同 external_id 已存在时更新元数据并返回既有记录。 */
  save(hit: PaperHit): PaperRecord {
    const existing = this.findBySource(hit.source, hit.externalId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE papers SET title=?, authors_json=?, year=?, venue=?, abstract=?, url=?, pdf_url=? WHERE id=?`,
        )
        .run(
          hit.title,
          JSON.stringify(hit.authors),
          hit.year,
          hit.venue,
          hit.abstract,
          hit.url,
          hit.pdfUrl,
          existing.id,
        );
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO papers (id, title, authors_json, year, venue, abstract, source, external_id, url, pdf_url, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hit.title,
        JSON.stringify(hit.authors),
        hit.year,
        hit.venue,
        hit.abstract,
        hit.source,
        hit.externalId,
        hit.url,
        hit.pdfUrl,
        Date.now(),
      );
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  }

  setPdfPath(id: string, pdfPath: string): void {
    this.db.prepare('UPDATE papers SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
  }
}
