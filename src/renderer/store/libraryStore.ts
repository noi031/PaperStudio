// P3 文献库状态：检索结果、已入库论文、总结流式缓冲与历史。
import { create } from 'zustand';
import type {
  PaperHit,
  PaperRecord,
  PapersEvent,
  SummaryEvent,
  SummaryRecord,
  NoteRecord,
  NoteType,
} from '../../shared/types';

export interface StreamingSummary {
  paperId: string;
  text: string;
  error: string | null;
  running: boolean;
}

interface LibraryStore {
  hits: PaperHit[];
  searching: boolean;
  searchError: string | null;
  searchWarnings: string[];
  papers: PaperRecord[];
  summaries: Record<string, SummaryRecord[]>;
  streaming: Record<string, StreamingSummary>;
  notes: Record<string, NoteRecord[]>;
  runSearch: (query: string, limit?: number, offset?: number, cursor?: string) => Promise<{ nextCursor: string | null; count: number }>;
  loadPapers: () => Promise<void>;
  saveHit: (hit: PaperHit) => Promise<void>;
  removePaper: (id: string) => Promise<void>;
  /** 已发起/进行中的 PDF 下载任务（按论文 id；支持并发多任务）。 */
  pdfJobs: Record<string, PdfJobState>;
  /**
   * 发起 PDF 下载：立即返回（后台任务），进度与结果经 papers:event 推送后由
   * handlePapersEvent 写回 pdfJobs。多篇可同时下载。
   */
  downloadPdf: (id: string) => Promise<{
    ok: boolean;
    status?: 'started' | 'running' | 'done';
    path?: string | null;
    message?: string;
  }>;
  /** 停止某篇 PDF 下载。 */
  stopDownload: (id: string) => Promise<void>;
  handlePapersEvent: (evt: PapersEvent) => void;
  loadSummaries: (paperId: string) => Promise<void>;
  startSummary: (
    paperId: string,
    kind: 'selected' | 'full',
    text: string,
    images?: Array<{ page: number; dataUrl: string }>,
  ) => Promise<void>;
  handleSummaryEvent: (evt: SummaryEvent) => void;
  loadNotes: (paperId: string) => Promise<void>;
  addNote: (paperId: string, page: number, type: NoteType, text: string, content: string, color?: string | null) => Promise<void>;
  updateNote: (id: string, patch: { content?: string; type?: NoteType; text?: string; color?: string | null }) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
}

/** PDF 后台下载任务状态（进度来自 papers:event）。 */
export interface PdfJobState {
  status: 'running' | 'done' | 'error' | 'stopped';
  loaded: number;
  total: number | null;
  path?: string | null;
  message?: string;
  elapsedMs?: number;
}

/** 下载按钮/提示条用的进度文案，如「下载中…42%」。 */
export function pdfProgressLabel(job?: PdfJobState): string {
  if (!job) return '下载中…';
  if (job.status === 'stopped') return '已停止';
  if (job.status === 'error') return '下载失败';
  if (job.status === 'done') return '已下载';
  if (job.total && job.total > 0) {
    const pct = Math.min(99, Math.round((job.loaded / job.total) * 100));
    return `下载中…${pct}%`;
  }
  if (job.loaded > 0) return `下载中…${(job.loaded / 1048576).toFixed(1)}MB`;
  return '下载中…';
}

const emptyStream = (paperId: string): StreamingSummary => ({ paperId, text: '', error: null, running: true });

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  hits: [],
  searching: false,
  searchError: null,
  searchWarnings: [],
  papers: [],
  summaries: {},
  streaming: {},
  notes: {},
  pdfJobs: {},

  runSearch: async (query, limit, offset, cursor) => {
    if (!query.trim()) return { nextCursor: null, count: 0 };
    set({ searching: true, searchError: null, searchWarnings: [] });
    try {
      const res = (await window.paper.invoke('search:run', { query: query.trim(), limit, offset, cursor })) as {
        hits: PaperHit[];
        warnings: string[];
        nextCursor?: string | null;
      };
      set({ hits: res.hits, searchWarnings: res.warnings });
      return { nextCursor: res.nextCursor ?? null, count: res.hits.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ searchError: message.replace(/^Error invoking remote method '[^']+': /, '') });
      return { nextCursor: null, count: 0 };
    } finally {
      set({ searching: false });
    }
  },

  loadPapers: async () => {
    const papers = (await window.paper.invoke('papers:list')) as PaperRecord[];
    set({ papers });
  },

  saveHit: async (hit) => {
    await window.paper.invoke('papers:save', { hit });
    await get().loadPapers();
  },

  removePaper: async (id) => {
    await window.paper.invoke('papers:delete', { id });
    await get().loadPapers();
  },

  downloadPdf: async (id) => {
    const res = (await window.paper.invoke('papers:downloadPdf', { id })) as {
      ok: boolean;
      status?: 'started' | 'running' | 'done';
      path?: string | null;
      message?: string;
    };
    if (res.ok && res.path) {
      // 本地已有有效 PDF：直接完成，无需等事件。
      set((st) => ({
        pdfJobs: { ...st.pdfJobs, [id]: { status: 'done', loaded: 0, total: null, path: res.path ?? null } },
      }));
      await get().loadPapers();
    } else if (res.ok) {
      set((st) => ({
        pdfJobs: {
          ...st.pdfJobs,
          [id]: { ...(st.pdfJobs[id] ?? { loaded: 0, total: null }), status: 'running' },
        },
      }));
    }
    return res;
  },

  handlePapersEvent: (evt) => {
    set((st) => {
      const prev: PdfJobState = st.pdfJobs[evt.id] ?? { status: 'running', loaded: 0, total: null };
      if (evt.type === 'progress') {
        return {
          pdfJobs: { ...st.pdfJobs, [evt.id]: { ...prev, status: 'running', loaded: evt.loaded, total: evt.total } },
        };
      }
      if (evt.type === 'done') {
        return {
          pdfJobs: {
            ...st.pdfJobs,
            [evt.id]: {
              status: 'done',
              loaded: prev.total ?? prev.loaded,
              total: prev.total,
              path: evt.path,
              elapsedMs: evt.elapsedMs,
            },
          },
        };
      }
      if (evt.type === 'stopped') {
        return { pdfJobs: { ...st.pdfJobs, [evt.id]: { ...prev, status: 'stopped' } } };
      }
      return { pdfJobs: { ...st.pdfJobs, [evt.id]: { ...prev, status: 'error', message: evt.message } } };
    });
    if (evt.type === 'done') void get().loadPapers();
  },

  stopDownload: async (id) => {
    await window.paper.invoke('papers:downloadStop', { id });
  },

  loadSummaries: async (paperId) => {
    const list = (await window.paper.invoke('summaries:list', { paperId })) as SummaryRecord[];
    set((s) => ({ summaries: { ...s.summaries, [paperId]: list } }));
  },

  startSummary: async (paperId, kind, text, images) => {
    const { id } = await window.paper.invoke('summary:run', { paperId, kind, text, images });
    set((s) => ({ streaming: { ...s.streaming, [id]: emptyStream(paperId) } }));
  },

  handleSummaryEvent: (evt) => {
    const cur = get().streaming[evt.id];
    if (!cur) return;
    if (evt.kind === 'delta') {
      set((s) => ({
        streaming: { ...s.streaming, [evt.id]: { ...cur, text: cur.text + evt.text } },
      }));
    } else if (evt.kind === 'error') {
      set((s) => ({
        streaming: { ...s.streaming, [evt.id]: { ...cur, error: evt.message, running: false } },
      }));
    } else {
      set((s) => {
        const next = { ...s.streaming };
        delete next[evt.id];
        return { streaming: next };
      });
      // done：刷新该论文的历史总结
      void get().loadSummaries(cur.paperId);
    }
  },

  loadNotes: async (paperId) => {
    const list = (await window.paper.invoke('notes:list', { paperId })) as NoteRecord[];
    set((s) => ({ notes: { ...s.notes, [paperId]: list } }));
  },

  addNote: async (paperId, page, type, text, content, color) => {
    await window.paper.invoke('notes:add', { paperId, page, type, text, content, color });
    await get().loadNotes(paperId);
  },

  updateNote: async (id, patch) => {
    await window.paper.invoke('notes:update', { id, ...patch });
  },

  deleteNote: async (id) => {
    await window.paper.invoke('notes:delete', { id });
  },
}));
