// AI 助手页状态：会话列表、消息、流式缓冲、跨页引用块（@段落 → 一次性发出）。
import { create } from 'zustand';
import type { AgentMessageLite, AgentSessionLite } from '../../shared/types';

/** 跨页引用块：阅读器选中的段落（@引用），发送时与用户追加的问题合并成一条消息。 */
export interface PendingQuote {
  id: string;
  source: string;
  page: number;
  text: string;
}

export interface StreamingState {
  text: string;
  reasoning: string;
  toolName: string | null;
  toolArgs: string;
}

export interface AssistantStore {
  health: { ok: boolean; version?: string; message?: string } | null;
  sessions: AgentSessionLite[];
  currentId: string | null;
  messages: Record<string, AgentMessageLite[]>;
  streaming: Record<string, StreamingState>;
  status: Record<string, 'idle' | 'running'>;
  pendingQuotes: PendingQuote[];
  error: string | null;
  loadHealth: () => Promise<void>;
  loadSessions: (selectId?: string) => Promise<void>;
  createSession: (title?: string, context?: string) => Promise<AgentSessionLite | null>;
  deleteSession: (id: string) => Promise<void>;
  selectSession: (id: string) => void;
  send: (text: string) => Promise<void>;
  stop: (id?: string) => Promise<void>;
  appendQuote: (q: Omit<PendingQuote, 'id'>) => void;
  removeQuote: (id: string) => void;
  clearQuotes: () => void;
  handleAgentEvent: (payload: unknown) => void;
}

// 模块级 in-flight 去重：React StrictMode 下 effect 双执行（挂载→卸载→再挂载），
// AssistantPage 的 pendingQuotes effect 会连续调用两次 createSession；
// 若并发创建（第一次还没返回），第二次直接复用同一个 promise，避免「一个上下文建两个会话」。
let creatingSession: Promise<AgentSessionLite | null> | null = null;

let quoteSeq = 0;

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  health: null,
  sessions: [],
  currentId: null,
  messages: {},
  streaming: {},
  status: {},
  pendingQuotes: [],
  error: null,

  loadHealth: async () => {
    const health = (await window.paper.invoke('agent:health')) as AssistantStore['health'];
    set({ health });
  },

  loadSessions: async (selectId) => {
    const sessions = (await window.paper.invoke('agent:listSessions')) as AgentSessionLite[];
    const currentId = selectId ?? get().currentId ?? sessions[0]?.id ?? null;
    set({ sessions, currentId });
    if (currentId) {
      const msgs = (await window.paper.invoke('agent:listMessages', { id: currentId })) as AgentMessageLite[];
      set((s) => ({ messages: { ...s.messages, [currentId]: msgs } }));
    }
  },

  createSession: async (title, context) => {
    // StrictMode 双 effect 并发：复用进行中的创建，防止建出两个会话。
    if (creatingSession) return creatingSession;
    const p = (async () => {
      const s = (await window.paper.invoke('agent:createSession', {
        title: title ?? '未命名会话',
        context: context ?? '',
      })) as AgentSessionLite;
      await get().loadSessions(s.id);
      return s;
    })();
    creatingSession = p;
    try {
      return await p;
    } finally {
      creatingSession = null;
    }
  },

  deleteSession: async (id) => {
    await window.paper.invoke('agent:deleteSession', { id });
    const { currentId, sessions } = get();
    const next = currentId === id ? sessions.find((x) => x.id !== id)?.id ?? null : currentId;
    await get().loadSessions(next ?? undefined);
  },

  selectSession: (id) => {
    set({ currentId: id });
    void (async () => {
      const msgs = (await window.paper.invoke('agent:listMessages', { id })) as AgentMessageLite[];
      set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
    })();
  },

  send: async (text) => {
    const { currentId } = get();
    if (!currentId) return;
    set({ error: null });
    try {
      await window.paper.invoke('agent:sendMessage', { id: currentId, text });
      // 发送成功即清空引用块（连同输入框内容，由页面处理）
      set({ pendingQuotes: [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message.replace(/^Error invoking remote method '[^']+': /, '') });
    }
  },

  stop: async (id) => {
    const { currentId } = get();
    const target = id ?? currentId;
    if (!target) return;
    try {
      await window.paper.invoke('agent:stop', { id: target });
    } catch {
      // 打断失败不阻塞 UI
    }
  },

  appendQuote: (q) => {
    quoteSeq += 1;
    set((s) => ({ pendingQuotes: [...s.pendingQuotes, { ...q, id: `q${quoteSeq}` }] }));
  },

  removeQuote: (id) => {
    set((s) => ({ pendingQuotes: s.pendingQuotes.filter((x) => x.id !== id) }));
  },

  clearQuotes: () => set({ pendingQuotes: [] }),

  handleAgentEvent: (payload) => {
    const evt = payload as {
      type: string;
      sessionId?: string;
      message?: AgentMessageLite;
      status?: 'idle' | 'running';
      title?: string;
      kind?: string;
      text?: string;
      name?: string;
      args?: string;
      ok?: boolean;
      reason?: string;
    };
    if (!evt.sessionId) return;
    const sid = evt.sessionId;
    const empty = { text: '', reasoning: '', toolName: null, toolArgs: '' };

    switch (evt.type) {
      case 'message':
        if (evt.message) {
          set((s) => ({
            messages: { ...s.messages, [sid]: [...(s.messages[sid] ?? []), evt.message!] },
          }));
        }
        break;
      case 'delta':
        set((s) => {
          const cur = s.streaming[sid] ?? { ...empty };
          if (evt.kind === 'text') cur.text += evt.text ?? '';
          else if (evt.kind === 'reasoning') cur.reasoning += evt.text ?? '';
          return { streaming: { ...s.streaming, [sid]: { ...cur } } };
        });
        break;
      case 'status':
        set((s) => ({ status: { ...s.status, [sid]: evt.status ?? 'idle' } }));
        break;
      case 'title':
        if (evt.title) {
          set((s) => ({
            sessions: s.sessions.map((x) => (x.id === sid ? { ...x, title: evt.title! } : x)),
          }));
        }
        break;
      case 'tool':
        set((s) => {
          const cur = s.streaming[sid] ?? { ...empty };
          return {
            streaming: {
              ...s.streaming,
              [sid]: { ...cur, toolName: evt.name ?? '', toolArgs: evt.args ?? '' },
            },
          };
        });
        break;
      case 'tool-result':
        set((s) => {
          const cur = s.streaming[sid] ?? { ...empty };
          return { streaming: { ...s.streaming, [sid]: { ...cur, toolName: null, toolArgs: '' } } };
        });
        break;
      case 'finish':
        set((s) => {
          const next = { ...s.streaming };
          delete next[sid];
          return { streaming: next };
        });
        break;
      case 'error':
        set((s) => {
          const cur = s.streaming[sid] ?? { ...empty };
          return { streaming: { ...s.streaming, [sid]: { ...cur, text: cur.text + (evt.message ?? '') } } };
        });
        break;
    }
  },
}));
