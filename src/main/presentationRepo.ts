// P7 演示仓储：presentations 表读写。
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { PresentationRecord, SlideItem } from '../shared/types.js';

interface PresentationRow {
  id: string;
  source_type: string;
  source_id: string | null;
  title: string;
  slides_json: string;
  pptx_path: string | null;
  created_at: number;
}

function toRecord(r: PresentationRow): PresentationRecord {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    title: r.title,
    slides: JSON.parse(r.slides_json) as SlideItem[],
    pptxPath: r.pptx_path,
    createdAt: r.created_at,
  };
}

export class PresentationRepo {
  constructor(private readonly db: Database) {}

  list(): PresentationRecord[] {
    const rows = this.db.prepare('SELECT * FROM presentations ORDER BY created_at DESC').all() as PresentationRow[];
    return rows.map(toRecord);
  }

  get(id: string): PresentationRecord | null {
    const row = this.db.prepare('SELECT * FROM presentations WHERE id = ?').get(id) as PresentationRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(sourceType: string, sourceId: string | null, title: string): PresentationRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO presentations (id, source_type, source_id, title, slides_json, pptx_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, sourceType, sourceId, title, '[]', null, Date.now());
    return this.get(id)!;
  }

  update(id: string, patch: { slides?: SlideItem[]; pptxPath?: string | null }): PresentationRecord {
    const cur = this.get(id);
    if (!cur) throw new Error('演示不存在');
    const slides = patch.slides ?? cur.slides;
    const pptxPath = patch.pptxPath !== undefined ? patch.pptxPath : cur.pptxPath;
    this.db
      .prepare('UPDATE presentations SET slides_json = ?, pptx_path = ? WHERE id = ?')
      .run(JSON.stringify(slides), pptxPath, id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM presentations WHERE id = ?').run(id);
  }
}
