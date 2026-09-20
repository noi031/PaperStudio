// P6 草稿仓储：drafts 表读写。
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from './sqlite.js';
import type { DraftOutlineItem, DraftRecord, DraftSection } from '../shared/types.js';

interface DraftRow {
  id: string;
  paper_id: string | null;
  title: string;
  outline_json: string;
  sections_json: string;
  format: string;
  exported_path: string | null;
  reference_ids_json: string | null;
  created_at: number;
}

function toRecord(r: DraftRow): DraftRecord {
  let referenceIds: string[] = [];
  try {
    const parsed = JSON.parse(r.reference_ids_json ?? '[]');
    referenceIds = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    referenceIds = [];
  }
  return {
    id: r.id,
    paperId: r.paper_id,
    title: r.title,
    outline: JSON.parse(r.outline_json) as DraftOutlineItem[],
    sections: JSON.parse(r.sections_json) as DraftSection[],
    format: r.format,
    exportedPath: r.exported_path,
    referenceIds,
    createdAt: r.created_at,
  };
}

export class DraftRepo {
  constructor(private readonly db: SqliteDb) {}

  list(): DraftRecord[] {
    const rows = this.db.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all() as DraftRow[];
    return rows.map(toRecord);
  }

  get(id: string): DraftRecord | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(paperId: string | null, title: string, referenceIds: string[] = []): DraftRecord {
    const id = randomUUID();
    const refs = paperId && !referenceIds.includes(paperId) ? [paperId, ...referenceIds] : referenceIds;
    this.db
      .prepare(
        'INSERT INTO drafts (id, paper_id, title, outline_json, sections_json, format, exported_path, reference_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, paperId, title, '[]', '[]', 'tex', null, JSON.stringify(refs), Date.now());
    return this.get(id)!;
  }

  update(
    id: string,
    patch: {
      outline?: DraftOutlineItem[];
      sections?: DraftSection[];
      exportedPath?: string | null;
      referenceIds?: string[];
    },
  ): DraftRecord {
    const cur = this.get(id);
    if (!cur) throw new Error('草稿不存在');
    const outline = patch.outline ?? cur.outline;
    const sections = patch.sections ?? cur.sections;
    const exportedPath = patch.exportedPath !== undefined ? patch.exportedPath : cur.exportedPath;
    const referenceIds = patch.referenceIds ?? cur.referenceIds;
    this.db
      .prepare(
        'UPDATE drafts SET outline_json = ?, sections_json = ?, exported_path = ?, reference_ids_json = ? WHERE id = ?',
      )
      .run(JSON.stringify(outline), JSON.stringify(sections), exportedPath, JSON.stringify(referenceIds), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  /** 原子更新单个小节内容：JSON_SET 只写指定索引，并发撰写多个小节时互不覆盖。 */
  setSectionContent(id: string, index: number, content: string): void {
    const cur = this.get(id);
    const sec = cur?.sections[index];
    if (!cur || !sec) return;
    const updated = { ...sec, content };
    this.db
      .prepare(
        "UPDATE drafts SET sections_json = JSON_SET(sections_json, '$[' || CAST(? AS INTEGER) || ']', json(?)) WHERE id = ?",
      )
      .run(index, JSON.stringify(updated), id);
  }

  /** 手工编辑大纲（重排/增删/改标题说明）：outline_json 原子替换；
   *  sections 与大纲重新对齐——标题未变的小节保留已撰写内容，新增项为空。 */
  setOutline(id: string, outline: DraftOutlineItem[]): DraftRecord {
    const cur = this.get(id);
    if (!cur) return this.get(id)!;
    // 旧内容按「标题」建索引（同位置标题未变时优先用同位置的 content，避免误配）
    const oldSections = cur.sections;
    const byHeading = new Map<string, string>();
    oldSections.forEach((s) => {
      if (s.content && !byHeading.has(s.heading)) byHeading.set(s.heading, s.content);
    });
    const sections: DraftSection[] = outline.map((o, i) => {
      const samePos = oldSections[i];
      const content =
        samePos?.heading === o.heading && samePos.content ? samePos.content : byHeading.get(o.heading) ?? '';
      return { heading: o.heading, description: o.description, content };
    });
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE drafts SET outline_json = ?, sections_json = ? WHERE id = ?').run(
        JSON.stringify(outline),
        JSON.stringify(sections),
        id,
      );
    });
    transaction();
    return this.get(id)!;
  }
}
