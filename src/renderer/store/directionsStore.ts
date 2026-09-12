// P5 方向建议状态：记录列表、生成中状态。
import { create } from 'zustand';
import type { DirectionRecord } from '../../shared/types';

interface DirectionsStore {
  records: DirectionRecord[];
  loading: boolean;
  generating: boolean;
  error: string | null;
  load: () => Promise<void>;
  generate: (paperIds: string[]) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

export const useDirectionsStore = create<DirectionsStore>((set, get) => ({
  records: [],
  loading: false,
  generating: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const records = (await window.paper.invoke('directions:list')) as DirectionRecord[];
      set({ records });
    } finally {
      set({ loading: false });
    }
  },

  generate: async (paperIds) => {
    set({ generating: true, error: null });
    try {
      const res = await window.paper.invoke('directions:generate', { paperIds });
      if (!res.ok) {
        set({ error: res.message ?? '生成失败' });
        return false;
      }
      await get().load();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      set({ generating: false });
    }
  },

  remove: async (id) => {
    await window.paper.invoke('directions:delete', { id });
    await get().load();
  },
}));
