// P6 写作状态：草稿列表、大纲生成、逐节撰写、导出。
import { create } from 'zustand';
import type { DraftRecord } from '../../shared/types';

interface WritingStore {
  drafts: DraftRecord[];
  loading: boolean;
  busy: { outlineFor: string | null; sectionFor: string | null; exportingFor: string | null };
  error: string | null;
  load: () => Promise<void>;
  create: (paperId: string | null, title: string, referenceIds?: string[]) => Promise<DraftRecord | null>;
  remove: (id: string) => Promise<void>;
  generateOutline: (id: string) => Promise<boolean>;
  writeSection: (id: string, index: number) => Promise<boolean>;
  setSection: (id: string, index: number, content: string) => Promise<void>;
  export: (id: string, format?: 'docx' | 'md' | 'tex' | 'bib') => Promise<string | null>;
}

export const useWritingStore = create<WritingStore>((set, get) => ({
  drafts: [],
  loading: false,
  busy: { outlineFor: null, sectionFor: null, exportingFor: null },
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const drafts = (await window.paper.invoke('drafts:list')) as DraftRecord[];
      set({ drafts });
    } finally {
      set({ loading: false });
    }
  },

  create: async (paperId, title, referenceIds) => {
    const record = (await window.paper.invoke('drafts:create', { paperId, title, referenceIds: referenceIds ?? [] })) as DraftRecord;
    await get().load();
    return record;
  },

  remove: async (id) => {
    await window.paper.invoke('drafts:delete', { id });
    await get().load();
  },

  generateOutline: async (id) => {
    set({ busy: { ...get().busy, outlineFor: id }, error: null });
    try {
      const res = await window.paper.invoke('drafts:generateOutline', { id });
      if (!res.ok) {
        set({ error: res.message ?? '大纲生成失败' });
        return false;
      }
      await get().load();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      set({ busy: { ...get().busy, outlineFor: null } });
    }
  },

  writeSection: async (id, index) => {
    set({ busy: { ...get().busy, sectionFor: `${id}:${index}` }, error: null });
    try {
      const res = await window.paper.invoke('drafts:writeSection', { id, index });
      if (!res.ok) {
        set({ error: res.message ?? '小节撰写失败' });
        return false;
      }
      await get().load();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      set({ busy: { ...get().busy, sectionFor: null } });
    }
  },

  setSection: async (id, index, content) => {
    await window.paper.invoke('drafts:setSection', { id, index, content });
    set((s) => ({
      drafts: s.drafts.map((d) =>
        d.id === id
          ? { ...d, sections: d.sections.map((sec, i) => (i === index ? { ...sec, content } : sec)) }
          : d,
      ),
    }));
  },

  export: async (id, format) => {
    set({ busy: { ...get().busy, exportingFor: id }, error: null });
    try {
      const res = await window.paper.invoke('drafts:export', { id, format });
      if (!res.ok) {
        set({ error: res.message ?? '导出失败' });
        return null;
      }
      await get().load();
      return res.path ?? null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      set({ busy: { ...get().busy, exportingFor: null } });
    }
  },
}));
