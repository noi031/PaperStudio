// 主进程 IPC 注册：所有通道集中在此，按阶段扩展。
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db';
import type { PaperSettings } from '../shared/types.js';
import type { DraftOutlineItem } from '../shared/types.js';
import type { AgentService } from './agentService';
import type { AgentSessionLite, AgentMessageLite, PaperHit, PaperRecord } from '../shared/types.js';
import type { PaperRepo } from './paperRepo';
import type { PdfService } from './pdfService';
import type { SummaryRepo } from './summaryRepo';
import type { SummaryService } from './summaryService';
import type { QaService } from './qaService';
import type { SummaryKind } from '../shared/types.js';
import type { DirectionRepo } from './directionRepo';
import type { DraftRepo } from './draftRepo';
import type { PresentationRepo } from './presentationRepo';
import type { NoteRepo } from './noteRepo';
import type { NoteType } from '../shared/types.js';
import { search } from './searchService.js';
import { agenticSearch } from './agenticSearch.js';
import { generateDirections } from './directionService.js';
import { generateOutline, writeSection, exportDraft } from './writingService.js';
import { generateSlides, exportPptx } from './presentationService.js';
import { writeSummaryMd } from './summaryService.js';
import { PDFDocument } from 'pdf-lib';

/** 事件发射器：Web(Host) 版为 SSE 广播（/events）。 */
export type HostEmit = (type: string, payload: unknown) => void;

/** 通道注册器：由 HTTP RPC 适配器（src/host/server.ts 的 /rpc/<channel>）实现。 */
export interface HandlerRegistrar {
  handle(channel: string, fn: (req: any) => unknown): void;
}

export interface IpcDeps {
  /** 向渲染层广播事件（agent:event / summary:event / search:event）。 */
  emit: HostEmit;
  db: Db;
  agent: AgentService;
  papers: PaperRepo;
  pdf: PdfService;
  summaries: SummaryRepo;
  summary: SummaryService;
  qa: QaService;
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

export function registerIpc(ipc: HandlerRegistrar, deps: IpcDeps): void {
  // 正在后台下载 PDF 的论文（同一个 id 只跑一个任务；记录 AbortController 用于停止）。
  const pdfJobs = new Map<string, { controller: AbortController }>();
  const { db, agent, papers, pdf, summaries, summary, qa, directions, drafts, presentations, notes, getSettings, storageDir, exportDir, markdownDir } = deps;

  ipc.handle('settings:get', () => db.getSettings());
  ipc.handle('settings:save', (patch: Partial<PaperSettings>) => db.saveSettings(patch));
  ipc.handle('db:ping', () => db.ping());

  // ── agent ─────────────────────────────────────────────────
    // health 幂等自动启动：打开 AI 助手页即建立 EchoCap 代理宿主连接，
    // 徽章显示引擎版本而非「未启动」；启动失败（如 socket / 鉴权缺失）返回错误消息给 UI 展示。
  ipc.handle('agent:health', async () => {
    try {
      await agent.ensureStarted();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return agent.health();
  });

  ipc.handle('agent:listSessions', () => agent.listSessions().map(toSessionLite));

  ipc.handle('agent:createSession', (req: { title?: string; context?: string }) => {
    const s = agent.createSession(req.title ?? '未命名会话', req.context ?? '');
    return toSessionLite(s);
  });
  ipc.handle('agent:deleteSession', (req: { id: string }) => {
    agent.deleteSession(req.id);
  });

  ipc.handle('agent:listMessages', (req: { id: string }) =>
    agent.listMessages(req.id).map(toMessageLite),
  );

  ipc.handle('agent:sendMessage', async (req: { id: string; text: string }) => {
    await agent.sendMessage(req.id, req.text);
    return { ok: true };
  });

  ipc.handle('agent:stop', (req: { id: string }) => {
    void agent.stop(req.id);
  });

  // ── P3 读的闭环 ───────────────────────────────────────────
  ipc.handle('search:run', async (req: { query: string; limit?: number; offset?: number; cursor?: string }) =>
    search(req.query, req.limit ?? 10, { s2ApiKey: getSettings().semanticScholarApiKey, oaCursor: req.cursor }, req.offset ?? 0),
  );

  // Agentic 检索：自然语言提问 → LLM 生成查询 → 多源检索合并 → LLM 评估相关度。
  // 阶段进度经 search:event 推送（plan / searching / scoring）。
  ipc.handle('search:agentic', async (req: { question: string }) => {
    const emit = (stage: 'plan' | 'searching' | 'scoring') => deps.emit('search:event', { stage });
    try {
      const result = await agenticSearch(req.question, getSettings(), emit);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle('papers:list', () => papers.list());

  ipc.handle('papers:save', (req: { hit: PaperHit }) => papers.save(req.hit));

  ipc.handle('papers:delete', (req: { id: string }) => {
    papers.remove(req.id);
  });

  // 下载 PDF：后台任务 + 事件推送。
  // arXiv 等源站对单连接限速只有几 KB/s，整篇下载要数分钟；若同步等待返回，
  // 网关会先判超时并回 "Bad Gateway" 纯文本，前端 JSON.parse 就会抛
  // `Unexpected token 'B', "Bad Gateway " is not valid JSON`。
  // 因此这里立即返回任务状态，进度与结果统一经 papers:event 推送。
  // 多任务并发：pdfJobs 按论文 id 记录，可同时下载多篇；每篇可单独停止。
  ipc.handle('papers:downloadPdf', (req: { id: string; force?: boolean }) => {
    const p = papers.get(req.id);
    if (!p) return { ok: false, message: '论文不存在' };
    if (!req.force && p.pdfPath && fs.existsSync(p.pdfPath)) return { ok: true, status: 'done', path: p.pdfPath };
    if (!p.pdfUrl) return { ok: false, message: '该论文无可用 PDF 链接' };
    if (pdfJobs.has(p.id)) return { ok: true, status: 'running' };

    const startedAt = Date.now();
    let lastEmit = 0;
    const controller = new AbortController();
    const job = (async () => {
      try {
        const pdfPath = await pdf.ensureDownloaded(p, {
          onProgress: ({ loaded, total }) => {
            const now = Date.now();
            // 按 1s 节流（下载结束那一帧必发），避免高频事件刷屏。
            const finished = total !== null && loaded >= total;
            if (!finished && now - lastEmit < 1000) return;
            lastEmit = now;
            deps.emit('papers:event', { type: 'progress', id: p.id, loaded, total });
          },
          signal: controller.signal,
          force: req.force,
        });
        papers.setPdfPath(p.id, pdfPath);
        deps.emit('papers:event', {
          type: 'done',
          id: p.id,
          path: pdfPath,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          deps.emit('papers:event', { type: 'stopped', id: p.id });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[papers] PDF 下载失败 ${p.id}: ${message}`);
        deps.emit('papers:event', { type: 'error', id: p.id, message });
      } finally {
        pdfJobs.delete(p.id);
      }
    })();
    pdfJobs.set(p.id, { controller });
    void job;
    return { ok: true, status: 'started' };
  });

  // 停止某篇 PDF 下载（并发多任务中单独停止）。
  ipc.handle('papers:downloadStop', (req: { id: string }) => {
    const job = pdfJobs.get(req.id);
    if (!job) return { ok: false, message: '没有正在进行的下载' };
    job.controller.abort();
    return { ok: true };
  });

  // ── 本地 PDF 导入 ─────────────────────────────────────────
  ipc.handle('papers:importLocalPdf', async (req: { path: string }) => {
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
  ipc.handle('paper:exportBundle', async (req: { id: string }) => {
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

  ipc.handle('paper:importBundle', async (req: { path: string }) => {
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

  ipc.handle('reader:open', async (req: { id: string }) => {
    const p = papers.get(req.id);
    if (!p) return { error: '论文不存在' };
    try {
      const result = await pdf.ensureAndRead(p);
      papers.setPdfPath(p.id, result.pdfPath);
      // 记录最近阅读时间（方向建议/写作/演示页的论文列表按此排序）
      papers.markRead(p.id);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle('summaries:list', (req: { paperId: string }) => summaries.listByPaper(req.paperId));

  ipc.handle(
    'summary:run',
    (req: { paperId: string; kind: SummaryKind; text: string; images?: Array<{ page: number; dataUrl: string }> }) => {
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

  // ── 阅读器 AI 问答 ────────────────────────────────────────
  // 基于论文全文/高亮文本回答问题：立即返回 job id，回答完成后生成 Markdown，
  // 增量与结果经 qa:event 推送（done 携带 mdPath）。
  ipc.handle(
    'qa:run',
    (req: { paperId: string; paperTitle: string; fullText: string; question: string; annotation?: string }) =>
      qa.run(req.paperId, req.paperTitle, req.fullText, req.question, req.annotation),
  );

  // ── 行内批注 ──────────────────────────────────────────────
  ipc.handle('notes:list', (req: { paperId: string }) => notes.listByPaper(req.paperId));

  ipc.handle(
    'notes:add',
    (req: { paperId: string; page: number; type: NoteType; text: string; content: string; color?: string | null }) =>
      notes.insert(req.paperId, req.page, req.type, req.text, req.content, db.getSettings().username || 'me', req.color ?? null),
  );

  ipc.handle(
    'notes:update',
    (req: { id: string; content?: string; type?: NoteType; text?: string; color?: string | null }) =>
      notes.update(req.id, req),
  );

  ipc.handle('notes:delete', (req: { id: string }) => {
    notes.remove(req.id);
  });

  ipc.handle('notes:export', (req: { paperId: string }) => {
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

  ipc.handle('notes:import', (req: { paperId: string; json: string }) => {
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
  ipc.handle('directions:list', () => directions.list());

  ipc.handle('directions:generate', async (req: { paperIds: string[] }) => {
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

  ipc.handle('directions:delete', (req: { id: string }) => {
    directions.remove(req.id);
  });

  // ── P6 写作 ───────────────────────────────────────────────
  ipc.handle('drafts:list', () => drafts.list());

  ipc.handle('drafts:create', (req: { paperId: string | null; title: string; referenceIds?: string[] }) =>
    drafts.insert(req.paperId, req.title, req.referenceIds ?? []),
  );

  ipc.handle('drafts:delete', (req: { id: string }) => {
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
      // 主论文在列表首位（ref1）：与 AI 撰写上下文（ref1 = 主论文）及导出 \cite 编号完全一致
      references: list,
    };
  }

  ipc.handle('drafts:generateOutline', async (req: { id: string }) => {
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

  ipc.handle('drafts:writeSection', async (req: { id: string; index: number; instruction?: string; existing?: string }) => {
    const d = drafts.get(req.id);
    if (!d) return { ok: false, message: '草稿不存在' };
    if (d.outline.length === 0) return { ok: false, message: '请先生成大纲' };
    const item = d.outline[req.index];
    if (!item) return { ok: false, message: '小节不存在' };
    const { paper, references } = draftContext(d);
    if (!paper && references.length === 0) return { ok: false, message: '草稿没有关联任何论文' };
    try {
      const content = await writeSection(
        getSettings(),
        { paper, references },
        d.outline,
        item,
        req.instruction,
        req.existing,
      );
      // 原子更新该小节（并发撰写多个小节时互不覆盖）
      drafts.setSectionContent(req.id, req.index, content);
      const record = drafts.get(req.id)!;
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle('drafts:setSection', (req: { id: string; index: number; content: string }) => {
    drafts.setSectionContent(req.id, req.index, req.content);
    return drafts.get(req.id)!;
  });

  // 手工编辑大纲（标题/说明增删改）；已撰写小节内容按标题保留。
  ipc.handle('drafts:setOutline', (req: { id: string; outline: DraftOutlineItem[] }) => {
    const items = (Array.isArray(req.outline) ? req.outline : []).filter(
      (o) => o && typeof o.heading === 'string' && o.heading.trim(),
    );
    return drafts.setOutline(req.id, items);
  });

  // 修改参考文献列表（顺序即 \cite{refN} 编号顺序；主论文自动排除，不占引用编号）
  ipc.handle('drafts:setReferences', (req: { id: string; referenceIds?: string[] }) => {
    const d = drafts.get(req.id);
    const ids = (Array.isArray(req.referenceIds) ? req.referenceIds : [])
      .filter((x) => x && x !== d?.paperId)
      .slice(0, 50);
    return drafts.update(req.id, { referenceIds: ids });
  });

  ipc.handle('drafts:export', async (req: { id: string; format?: 'docx' | 'md' | 'tex' | 'bib' }) => {
    const d = drafts.get(req.id);
    if (!d) return { ok: false, message: '草稿不存在' };
    const empty = d.sections.filter((s) => !s.content.trim()).length;
    if (empty > 0) return { ok: false, message: `还有 ${empty} 个小节未撰写（可留空导出，或先补齐）` };
    const { references } = draftContext(d);
    try {
      const { filePath, bibPath } = await exportDraft(
        { title: d.title, username: getSettings().username || 'me', sections: d.sections, references },
        req.format ?? 'tex',
        exportDir,
      );
      drafts.update(d.id, { exportedPath: filePath });
      // 导出 TEX 时服务端同时生成与 .tex 同名的 .bib，一并返回下载路径（无条件：无参考论文也生成空 bib）
      return { ok: true, path: filePath, bibPath };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── P7 演示 ───────────────────────────────────────────────
  ipc.handle('presentations:list', () => presentations.list());

  ipc.handle('presentations:create', (req: { paperId: string | null; title: string }) =>
    presentations.insert('paper', req.paperId, req.title),
  );

  ipc.handle('presentations:generateSlides', async (req: { id: string }) => {
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

  ipc.handle('presentations:delete', (req: { id: string }) => {
    presentations.remove(req.id);
  });

  ipc.handle('presentations:export', async (req: { id: string }) => {
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
