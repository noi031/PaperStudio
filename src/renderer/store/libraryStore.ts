// P3 文献库状态：检索结果、已入库论文、总结流式缓冲与历史。
import { create } from 'zustand';
import type { PaperHit, PaperRecord, SummaryEvent, SummaryRecord, NoteRecord, NoteType } from '../../shared/types';

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
  runSearch: (query: string, limit?: number) => Promise<void>;
  loadPapers: () => Promise<void>;
  saveHit: (hit: PaperHit) => Promise<void>;
  removePaper: (id: string) => Promise<void>;
  downloadPdf: (id: string) => Promise<{ ok: boolean; path?: string | null; message?: string }>;
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

  runSearch: async (query, limit) => {
    if (!query.trim()) return;
    set({ searching: true, searchError: null, searchWarnings: [] });
    try {
      const res = (await window.paper.invoke('search:run', { query: query.trim(), limit })) as {
        hits: PaperHit[];
        warnings: string[];
      };
      set({ hits: res.hits, searchWarnings: res.warnings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ searchError: message.replace(/^Error invoking remote method '[^']+': /, '') });
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
      path?: string | null;
      message?: string;
    };
    if (res.ok) await get().loadPapers();
    return res;
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
