// assistantStore.createSession 并发去重单测：
// 复现「选中文本发送到助手」在 React StrictMode 下 effect 双执行（挂载→卸载→再挂载），
// pendingContext effect 会连续调用两次 createSession；若并发创建，第二次必须复用第一次，
// 否则会建出两个会话、各发一条上下文消息。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantStore } from '../assistantStore';

interface PaperApi {
  invoke: ReturnType<typeof vi.fn>;
  onAgentEvent: ReturnType<typeof vi.fn>;
}

const api: PaperApi = {
  invoke: vi.fn(),
  onAgentEvent: vi.fn(() => () => {}),
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = { paper: api };
  api.invoke.mockReset();
  api.onAgentEvent.mockReset();
  api.onAgentEvent.mockImplementation(() => () => {});
  api.invoke.mockImplementation(async (ch: string) => {
    if (ch === 'agent:createSession') {
      return { id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: 't', createdAt: 1, updatedAt: 1 };
    }
    if (ch === 'agent:listSessions') return [];
    if (ch === 'agent:listMessages') return [];
    if (ch === 'agent:health') return { ok: true, version: 'test' };
    throw new Error('unexpected channel ' + ch);
  });
  useAssistantStore.setState({
    health: null,
    sessions: [],
    currentId: null,
    messages: {},
    streaming: {},
    status: {},
    pendingContext: null,
    error: null,
  });
});

describe('assistantStore.createSession 并发去重', () => {
  it('StrictMode 双 effect 并发调用只创建一个会话（invoke 仅一次）', async () => {
    // 不 await 第一次，模拟 effect 双执行的并发时序。
    const p1 = useAssistantStore.getState().createSession('来自阅读器', '论文：X\n\n选中段落');
    const p2 = useAssistantStore.getState().createSession('来自阅读器', '论文：X\n\n选中段落');
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1?.id).toBe(s2?.id);
    expect(api.invoke.mock.calls.filter((c) => c[0] === 'agent:createSession')).toHaveLength(1);
  });

  it('顺序（非并发）调用各自创建新会话', async () => {
    const s1 = await useAssistantStore.getState().createSession();
    const s2 = await useAssistantStore.getState().createSession();
    expect(
      api.invoke.mock.calls.filter((c) => c[0] === 'agent:createSession'),
    ).toHaveLength(2);
    expect(s1?.id).not.toBe(s2?.id);
  });

  it('创建失败后下一次调用可重试（in-flight 不残留）', async () => {
    api.invoke.mockImplementationOnce(async () => {
      throw new Error('no key');
    });
    const s1 = await useAssistantStore.getState().createSession().catch(() => null);
    expect(s1).toBeNull();
    const s2 = await useAssistantStore.getState().createSession();
    expect(s2?.id).toBeTruthy();
  });
});