// 主进程 IPC 注册：所有通道集中在此，按阶段扩展。
import fs from 'node:fs';
import path from 'node:path';
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
import { writeSummaryMd } from './summaryService.js';
import { PDFDocument } from 'pdf-lib';

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
  /** 总结 Markdown 工作目录（storage/markdown） */
  markdownDir: string;
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
  const { db, agent, papers, pdf, summaries, summary, directions, drafts, presentations, notes, getSettings, storageDir, exportDir, markdownDir } = deps;

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

  ipcMain.handle('agent:stop', (_e, req: { id: string }) => {
    void agent.stop(req.id);
  });

  // ── P3 读的闭环 ───────────────────────────────────────────
  ipcMain.handle('search:run', async (_e, req: { query: string; limit?: number; offset?: number; cursor?: string }) =>
    search(req.query, req.limit ?? 10, { s2ApiKey: getSettings().semanticScholarApiKey, oaCursor: req.cursor }, req.offset ?? 0),
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

  // ── 本地 PDF 导入 ─────────────────────────────────────────
  ipcMain.handle('papers:importLocalPdf', async (_e, req: { path: string }) => {
    try {
      const src = path.resolve(req.path);
      if (!fs.existsSync(src)) return { ok: false, message: '文件不存在' };
      const buf = fs.readFileSync(src);
      let doc: PDFDocument;
      try {
        doc = await PDFDocument.load(buf);
      } catch {
        return { ok: false, message: '无法解析该 PDF：文件损坏或已加密（需要密码的 PDF 不支持导入）' };
      }
      const title = (doc.getTitle() ?? '').trim() || path.basename(src, '.pdf');
      const authors = (doc.getAuthor() ?? '')
        .split(/[;,]/)
        .map((a) => a.trim())
        .filter(Boolean);
      const year = doc.getCreationDate() ? new Date(doc.getCreationDate() as Date).getFullYear() : null;
      const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'paper';
      const dest = path.join(storageDir, `${safe}.pdf`);
      fs.writeFileSync(dest, buf);
      const hit: PaperHit = {
        source: 'local',
        externalId: '',
        title,
        authors,
        year: Number.isNaN(Number(year)) ? null : year,
        venue: null,
        abstract: null,
        url: null,
        pdfUrl: null,
      };
      const paper = papers.save(hit);
      papers.setPdfPath(paper.id, dest);
      return { ok: true, paper };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── 论文一体化数据包（PDF + 批注 + 总结）导出/导入 ─────────
  ipcMain.handle('paper:exportBundle', async (_e, req: { id: string }) => {
    try {
      const p = papers.get(req.id);
      if (!p) return { ok: false, message: '论文不存在' };
      const pdfBase64 = p.pdfPath && fs.existsSync(p.pdfPath)
        ? fs.readFileSync(p.pdfPath).toString('base64')
        : null;
      const bundle = {
        app: 'PaperStudio',
        kind: 'paper-bundle',
        version: 1,
        exportedAt: Date.now(),
        paper: {
          title: p.title,
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          abstract: p.abstract,
          source: p.source,
          externalId: p.externalId,
          url: p.url,
          pdfUrl: p.pdfUrl,
        },
        pdfBase64,
        notes: notes.listByPaper(p.id).map((n) => ({
          page: n.page,
          type: n.type,
          text: n.text,
          content: n.content,
          color: n.color,
          author: n.author,
          createdAt: n.createdAt,
        })),
        summaries: summaries.listByPaper(p.id).map((s) => ({
          kind: s.kind,
          content: s.content,
          model: s.model,
          createdAt: s.createdAt,
        })),
      };
      fs.mkdirSync(exportDir, { recursive: true });
      const safe = p.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'paper';
      const filePath = path.join(exportDir, `${safe}.paperstudio`);
      fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('paper:importBundle', async (_e, req: { path: string }) => {
    try {
      const src = path.resolve(req.path);
      if (!fs.existsSync(src)) return { ok: false, message: '文件不存在' };
      const bundle = JSON.parse(fs.readFileSync(src, 'utf8')) as {
        app?: string;
        kind?: string;
        version?: number;
        paper?: {
          title?: unknown;
          authors?: unknown;
          year?: unknown;
          venue?: unknown;
          abstract?: unknown;
          source?: unknown;
          externalId?: unknown;
          url?: unknown;
          pdfUrl?: unknown;
        };
        pdfBase64?: unknown;
        notes?: Array<{
          page?: unknown;
          type?: unknown;
          text?: unknown;
          content?: unknown;
          color?: unknown;
          author?: unknown;
          createdAt?: unknown;
        }>;
        summaries?: Array<{ kind?: unknown; content?: unknown; model?: unknown; createdAt?: unknown }>;
      };
      if (bundle.app !== 'PaperStudio' || bundle.kind !== 'paper-bundle') {
        return { ok: false, message: '不是有效的 PaperStudio 论文包文件' };
      }
      const bp = bundle.paper ?? {};
      const title = String(bp.title ?? '未命名论文').trim() || '未命名论文';
      const hit: PaperHit = {
        source: (bp.source === 'arxiv' || bp.source === 'semantic_scholar' || bp.source === 'openalex' ? bp.source : 'local') as PaperHit['source'],
        externalId: typeof bp.externalId === 'string' ? bp.externalId : '',
        title,
        authors: Array.isArray(bp.authors) ? (bp.authors as string[]).map(String) : [],
        year: typeof bp.year === 'number' ? bp.year : null,
        venue: typeof bp.venue === 'string' ? bp.venue : null,
        abstract: typeof bp.abstract === 'string' ? bp.abstract : null,
        url: typeof bp.url === 'string' ? bp.url : null,
        pdfUrl: typeof bp.pdfUrl === 'string' ? bp.pdfUrl : null,
      };
      const paper = papers.save(hit);
      // PDF
      if (typeof bundle.pdfBase64 === 'string' && bundle.pdfBase64) {
        const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'paper';
        const dest = path.join(storageDir, `${safe}.pdf`);
        fs.writeFileSync(dest, Buffer.from(bundle.pdfBase64, 'base64'));
        papers.setPdfPath(paper.id, dest);
      }
      // 批注
      let importedNotes = 0;
      if (Array.isArray(bundle.notes)) {
        for (const n of bundle.notes) {
          const text = String(n.text ?? '').trim();
          if (!text) continue;
          notes.insert(
            paper.id,
            Number(n.page) || 1,
            n.type === 'comment' ? 'comment' : 'highlight',
            text,
            String(n.content ?? '').trim(),
            String(n.author ?? 'me') || 'me',
            typeof n.color === 'string' && n.color ? n.color : null,
          );
          importedNotes += 1;
        }
      }
      // 总结：重建 Markdown 文件
      if (Array.isArray(bundle.summaries)) {
        for (const s of bundle.summaries) {
          const kind: SummaryKind = s.kind === 'full' ? 'full' : 'selected';
          const content = String(s.content ?? '').trim();
          if (!content) continue;
          const mdPath = writeSummaryMd(markdownDir, paper.id, kind, content, paper.title);
          summaries.insert(paper.id, kind, content, typeof s.model === 'string' ? s.model : null, mdPath);
        }
      }
      return { ok: true, paper, message: importedNotes > 0 ? `已导入 ${importedNotes} 条批注` : undefined };
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

  ipcMain.handle(
    'summary:run',
    (_e, req: { paperId: string; kind: SummaryKind; text: string; images?: Array<{ page: number; dataUrl: string }> }) => {
      const p = papers.get(req.paperId);
      let figList = '';
      try {
        // 论文图表截图 → markdown/images/<paperId前8>/fig-<page>.png（与 MD 同工作目录，相对路径可解析）
        const imgDir = path.join(markdownDir, 'images', req.paperId.slice(0, 8));
        if (req.images?.length) {
          fs.mkdirSync(imgDir, { recursive: true });
          for (const img of req.images) {
            const b64 = img.dataUrl.split(',')[1];
            if (!b64) continue;
            fs.writeFileSync(path.join(imgDir, `fig-${img.page}.png`), Buffer.from(b64, 'base64'));
          }
          figList = req.images
            .map((img) => `第${img.page}页图：images/${req.paperId.slice(0, 8)}/fig-${img.page}.png`)
            .join('；');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[summary] 写图表失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return summary.run(req.paperId, req.kind, req.text, p?.title ?? '未知论文', figList);
    },
  );

  // ── 行内批注 ──────────────────────────────────────────────
  ipcMain.handle('notes:list', (_e, req: { paperId: string }) => notes.listByPaper(req.paperId));

  ipcMain.handle(
    'notes:add',
    (_e, req: { paperId: string; page: number; type: NoteType; text: string; content: string; color?: string | null }) =>
      notes.insert(req.paperId, req.page, req.type, req.text, req.content, db.getSettings().username || 'me', req.color ?? null),
  );

  ipcMain.handle(
    'notes:update',
    (_e, req: { id: string; content?: string; type?: NoteType; text?: string; color?: string | null }) =>
      notes.update(req.id, req),
  );

  ipcMain.handle('notes:delete', (_e, req: { id: string }) => {
    notes.remove(req.id);
  });

  ipcMain.handle('notes:export', (_e, req: { paperId: string }) => {
    const p = papers.get(req.paperId);
    if (!p) return { ok: false, message: '论文不存在' };
    if (notes.countByPaper(req.paperId) === 0) return { ok: false, message: '该论文还没有批注' };
    try {
      const filePath = notes.exportJson(req.paperId, p.title, p.externalId, path.join(exportDir, 'notes'));
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('notes:import', (_e, req: { paperId: string; json: string }) => {
    const p = papers.get(req.paperId);
    if (!p) return { ok: false, message: '论文不存在，请先保存论文再导入' };
    try {
      const count = notes.importJson(req.json, req.paperId);
      if (count === 0) return { ok: false, message: '文件中没有可导入的批注' };
      return { ok: true, imported: count };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
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
