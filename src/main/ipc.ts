// 主进程 IPC 注册：所有通道集中在此，按阶段扩展。
import type { IpcMain } from 'electron';
import type { Db } from './db';
import type { PaperSettings } from '../shared/types.js';
import type { AgentService } from './agentService';
import type { AgentSessionLite, AgentMessageLite, PaperHit, PaperRecord } from '../shared/types.js';
import type { PaperRepo } from './paperRepo';
import type { PdfService } from './pdfService';
import type { SummaryRepo } from './summaryRepo';
import type { SummaryService } from './summaryService';
import type { SummaryKind } from '../shared/types.js';
import type { DirectionRepo } from './directionRepo';
import type { DraftRepo } from './draftRepo';
import type { PresentationRepo } from './presentationRepo';
import type { NoteRepo } from './noteRepo';
import type { NoteType } from '../shared/types.js';
import { search } from './searchService.js';
import { generateDirections } from './directionService.js';
import { generateOutline, writeSection, exportDraft } from './writingService.js';
import { generateSlides, exportPptx } from './presentationService.js';

export interface IpcDeps {
  db: Db;
  agent: AgentService;
  papers: PaperRepo;
  pdf: PdfService;
  summaries: SummaryRepo;
  summary: SummaryService;
  directions: DirectionRepo;
  drafts: DraftRepo;
  presentations: PresentationRepo;
  notes: NoteRepo;
  getSettings: () => PaperSettings;
  /** PDF 存储目录（下载的论文） */
  storageDir: string;
  /** 导出文件目录（docx/md/tex/bib/pptx） */
  exportDir: string;
}

function toSessionLite(s: { id: string; title: string; createdAt: number; updatedAt: number }): AgentSessionLite {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

function toMessageLite(m: {
  id: string;
  role: string;
  kind: string;
  content: string;
  createdAt: number;
}): AgentMessageLite {
  return { id: m.id, role: m.role, kind: m.kind, content: m.content, createdAt: m.createdAt };
}

export function registerIpc(ipcMain: IpcMain, deps: IpcDeps): void {
  const { db, agent, papers, pdf, summaries, summary, directions, drafts, presentations, notes, getSettings, storageDir, exportDir } = deps;

  ipcMain.handle('settings:get', () => db.getSettings());
  ipcMain.handle('settings:save', (_e, patch: Partial<PaperSettings>) => db.saveSettings(patch));
  ipcMain.handle('db:ping', () => db.ping());

  // ── agent ─────────────────────────────────────────────────
  // health 幂等自动启动：打开 AI 助手页即拉起 dsh 引擎（配置了 API Key 时），
  // 徽章显示版本而非「未启动」；启动失败（如无 key）返回错误消息给 UI 展示。
  ipcMain.handle('agent:health', async () => {
    try {
      await agent.ensureStarted();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return agent.health();
  });

  ipcMain.handle('agent:listSessions', () => agent.listSessions().map(toSessionLite));

  ipcMain.handle('agent:createSession', (_e, req: { title?: string; context?: string }) => {
    const s = agent.createSession(req.title ?? '未命名会话', req.context ?? '');
    return toSessionLite(s);
  });
  ipcMain.handle('agent:deleteSession', (_e, req: { id: string }) => {
    agent.deleteSession(req.id);
  });

  ipcMain.handle('agent:listMessages', (_e, req: { id: string }) =>
    agent.listMessages(req.id).map(toMessageLite),
  );

  ipcMain.handle('agent:sendMessage', async (_e, req: { id: string; text: string }) => {
    await agent.sendMessage(req.id, req.text);
    return { ok: true };
  });

  // ── P3 读的闭环 ───────────────────────────────────────────
  ipcMain.handle('search:run', async (_e, req: { query: string; limit?: number }) =>
    search(req.query, req.limit ?? 10),
  );

  ipcMain.handle('papers:list', () => papers.list());

  ipcMain.handle('papers:save', (_e, req: { hit: PaperHit }) => papers.save(req.hit));

  ipcMain.handle('papers:delete', (_e, req: { id: string }) => {
    papers.remove(req.id);
  });

  ipcMain.handle('papers:downloadPdf', async (_e, req: { id: string }) => {
    const p = papers.get(req.id);
    if (!p) return { ok: false, message: '论文不存在' };
    try {
      const { pdfPath } = await pdf.ensureAndRead(p);
      papers.setPdfPath(p.id, pdfPath);
      return { ok: true, path: pdfPath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('reader:open', async (_e, req: { id: string }) => {
    const p = papers.get(req.id);
    if (!p) return { error: '论文不存在' };
    try {
      const result = await pdf.ensureAndRead(p);
      papers.setPdfPath(p.id, result.pdfPath);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('summaries:list', (_e, req: { paperId: string }) => summaries.listByPaper(req.paperId));

  ipcMain.handle('summary:run', (_e, req: { paperId: string; kind: SummaryKind; text: string }) => {
    const p = papers.get(req.paperId);
    return summary.run(req.paperId, req.kind, req.text, p?.title ?? '未知论文');
  });

  // ── 行内批注 ──────────────────────────────────────────────
  ipcMain.handle('notes:list', (_e, req: { paperId: string }) => notes.listByPaper(req.paperId));

  ipcMain.handle(
    'notes:add',
    (_e, req: { paperId: string; page: number; type: NoteType; text: string; content: string }) =>
      notes.insert(req.paperId, req.page, req.type, req.text, req.content, db.getSettings().username || 'me'),
  );

  ipcMain.handle('notes:delete', (_e, req: { id: string }) => {
    notes.remove(req.id);
  });

  // ── P5 方向建议 ───────────────────────────────────────────
  ipcMain.handle('directions:list', () => directions.list());

  ipcMain.handle('directions:generate', async (_e, req: { paperIds: string[] }) => {
    const selected = req.paperIds.length
      ? req.paperIds.map((id) => papers.get(id)).filter((p): p is NonNullable<typeof p> => p !== null)
      : papers.list();
    try {
      const suggestions = await generateDirections(getSettings, selected);
      const context = selected.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
      const record = directions.insert(context, suggestions);
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('directions:delete', (_e, req: { id: string }) => {
    directions.remove(req.id);
  });

  // ── P6 写作 ───────────────────────────────────────────────
  ipcMain.handle('drafts:list', () => drafts.list());

  ipcMain.handle('drafts:create', (_e, req: { paperId: string | null; title: string; referenceIds?: string[] }) =>
    drafts.insert(req.paperId, req.title, req.referenceIds ?? []),
  );

  ipcMain.handle('drafts:delete', (_e, req: { id: string }) => {
    drafts.remove(req.id);
  });

  /** 组装写作上下文：主论文（可能 null）+ 参考论文（去重）。 */
  function draftContext(d: { paperId: string | null; referenceIds: string[] }): {
    paper: PaperRecord | null;
    references: PaperRecord[];
  } {
    const seen = new Set<string>();
    const list: PaperRecord[] = [];
    for (const id of [d.paperId, ...d.referenceIds]) {
      if (!id || seen.has(id)) continue;
      const p = papers.get(id);
      if (p) {
        seen.add(id);
        list.push(p);
      }
    }
    return {
      paper: (d.paperId && papers.get(d.paperId)) || null,
      references: d.paperId ? list.filter((p) => p.id !== d.paperId) : list,
    };
  }

  ipcMain.handle('drafts:generateOutline', async (_e, req: { id: string }) => {
    const d = drafts.get(req.id);
    if (!d) return { ok: false, message: '草稿不存在' };
    const { paper, references } = draftContext(d);
    if (!paper && references.length === 0) return { ok: false, message: '草稿没有关联任何论文，请删除后重新创建' };
    try {
      const outline = await generateOutline(getSettings(), { paper, references });
      const sections = outline.map((o) => ({ heading: o.heading, content: '' }));
      const record = drafts.update(d.id, { outline, sections });
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('drafts:writeSection', async (_e, req: { id: string; index: number }) => {
    const d = drafts.get(req.id);
    if (!d) return { ok: false, message: '草稿不存在' };
    if (d.outline.length === 0) return { ok: false, message: '请先生成大纲' };
    const item = d.outline[req.index];
    if (!item) return { ok: false, message: '小节不存在' };
    const { paper, references } = draftContext(d);
    if (!paper && references.length === 0) return { ok: false, message: '草稿没有关联任何论文' };
    try {
      const content = await writeSection(getSettings(), { paper, references }, d.outline, item);
      const sections = d.sections.map((s, i) => (i === req.index ? { ...s, content } : s));
      const record = drafts.update(d.id, { sections });
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('drafts:setSection', (_e, req: { id: string; index: number; content: string }) => {
    const d = drafts.get(req.id);
    if (!d) throw new Error('草稿不存在');
    const sections = d.sections.map((s, i) => (i === req.index ? { ...s, content: req.content } : s));
    return drafts.update(d.id, { sections });
  });

  ipcMain.handle('drafts:export', async (_e, req: { id: string; format?: 'docx' | 'md' | 'tex' | 'bib' }) => {
    const d = drafts.get(req.id);
    if (!d) return { ok: false, message: '草稿不存在' };
    const empty = d.sections.filter((s) => !s.content.trim()).length;
    if (empty > 0) return { ok: false, message: `还有 ${empty} 个小节未撰写（可留空导出，或先补齐）` };
    const { references } = draftContext(d);
    try {
      const filePath = await exportDraft(
        { title: d.title, username: getSettings().username || 'me', sections: d.sections, references },
        req.format ?? 'tex',
        exportDir,
      );
      drafts.update(d.id, { exportedPath: filePath });
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── P7 演示 ───────────────────────────────────────────────
  ipcMain.handle('presentations:list', () => presentations.list());

  ipcMain.handle('presentations:create', (_e, req: { paperId: string | null; title: string }) =>
    presentations.insert('paper', req.paperId, req.title),
  );

  ipcMain.handle('presentations:generateSlides', async (_e, req: { id: string }) => {
    const pr = presentations.get(req.id);
    if (!pr) return { ok: false, message: '演示不存在' };
    const p = pr.sourceId ? papers.get(pr.sourceId) : null;
    if (!p) return { ok: false, message: '关联论文不存在，请删除后重新创建' };
    try {
      const slides = await generateSlides(getSettings(), p);
      const record = presentations.update(pr.id, { slides });
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('presentations:delete', (_e, req: { id: string }) => {
    presentations.remove(req.id);
  });

  ipcMain.handle('presentations:export', async (_e, req: { id: string }) => {
    const pr = presentations.get(req.id);
    if (!pr) return { ok: false, message: '演示不存在' };
    if (pr.slides.length === 0) return { ok: false, message: '请先生成幻灯片提纲' };
    try {
      const filePath = await exportPptx(pr, exportDir);
      presentations.update(pr.id, { pptxPath: filePath });
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}
