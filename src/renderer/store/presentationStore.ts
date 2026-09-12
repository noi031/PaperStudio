// P7 演示状态：演示列表、幻灯片生成、导出。
import { create } from 'zustand';
import type { PresentationRecord } from '../../shared/types';

interface PresentationStore {
  records: PresentationRecord[];
  loading: boolean;
  busy: { generatingFor: string | null; exportingFor: string | null };
  error: string | null;
  load: () => Promise<void>;
  create: (paperId: string | null, title: string) => Promise<PresentationRecord | null>;
  remove: (id: string) => Promise<void>;
  generateSlides: (id: string) => Promise<boolean>;
  export: (id: string) => Promise<string | null>;
}

export const usePresentationStore = create<PresentationStore>((set, get) => ({
  records: [],
  loading: false,
  busy: { generatingFor: null, exportingFor: null },
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const records = (await window.paper.invoke('presentations:list')) as PresentationRecord[];
      set({ records });
    } finally {
      set({ loading: false });
    }
  },

  create: async (paperId, title) => {
    const record = (await window.paper.invoke('presentations:create', { paperId, title })) as PresentationRecord;
    await get().load();
    return record;
  },

  remove: async (id) => {
    await window.paper.invoke('presentations:delete', { id });
    await get().load();
  },

  generateSlides: async (id) => {
    set({ busy: { ...get().busy, generatingFor: id }, error: null });
    try {
      const res = await window.paper.invoke('presentations:generateSlides', { id });
      if (!res.ok) {
        set({ error: res.message ?? '幻灯片生成失败' });
        return false;
      }
      await get().load();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      set({ busy: { ...get().busy, generatingFor: null } });
    }
  },

  export: async (id) => {
    set({ busy: { ...get().busy, exportingFor: id }, error: null });
    try {
      const res = await window.paper.invoke('presentations:export', { id });
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
