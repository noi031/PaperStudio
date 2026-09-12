// agentService.ts 编排单测：聚焦「同一会话连续多回合不重复累积」。
// 复现场景：每个回合 sendMessage 注册一个 dsh 事件 listener；旧 listener 若未注销，
// 下一回合的每个事件会同时触发所有累积 listener → 流式输出/落库按倍数重复。
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentService } from '../agentService';
import type { AgentHost } from '../agentHost';
import type { AgentRepo, AgentSession } from '../agentRepo';

interface FakeHost {
  active: Map<string, Set<(e: unknown) => void>>;
  started: boolean;
  ready: boolean;
  on(sessionId: string, listener: (e: unknown) => void): () => void;
  sendMessage(sessionId: string, text: string): Promise<void>;
  start(): Promise<string>;
  close(): Promise<void>;
  /** 测试手动触发「dsh 回合一整轮事件」：派发给当前 active listener 并清空待派发。 */
  emitTurn(sessionId: string): void;
  /** 直接对某会话派发一个原始事件（绕过 sendMessage，用于孤儿事件场景）。 */
  emitRaw(sessionId: string, e: unknown): void;
}

/** 可控假 dsh：sendMessage 只记录待派发 listeners，回合事件由测试手动 emitTurn 触发。 */
function makeHost(): FakeHost {
  const active = new Map<string, Set<(e: unknown) => void>>();
  const pending = new Map<string, Array<(e: unknown) => void>>();
  const host: FakeHost = {
    active,
    started: false,
    get ready() {
      return this.started;
    },
    on(sessionId, listener) {
      let set = active.get(sessionId);
      if (!set) {
        set = new Set();
        active.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    async start() {
      this.started = true;
      return '0.0.1';
    },
    async close() {
      active.clear();
      pending.clear();
    },
    async sendMessage(sessionId) {
      pending.set(sessionId, [...(active.get(sessionId) ?? [])]);
    },
    emitTurn(sessionId) {
      const listeners = pending.get(sessionId) ?? [];
      pending.delete(sessionId);
      const emit = (e: unknown) => listeners.forEach((l) => l(e));
      emit({ kind: 'status', status: 'running' });
      emit({ kind: 'text-delta', text: '答复' });
      emit({ kind: 'finish', reason: 'stop' });
      emit({ kind: 'assistant-message', text: '答复', reasoning: '' });
      emit({ kind: 'status', status: 'idle' });
    },
    emitRaw(sessionId, e) {
      for (const l of active.get(sessionId) ?? []) l(e);
    },
  };
  return host;
}

function makeRepo() {
  const messages: Array<{ sessionId: string; role: string; kind: string; content: string }> = [];
  const session: AgentSession = {
    id: 's1',
    title: 't',
    dshSessionId: 'dsh-s1',
    contextJson: '{}',
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    session,
    messages,
    repo: {
      getSession: () => session,
      appendMessage: (sessionId: string, role: string, kind: string, content: string) => {
        messages.push({ sessionId, role, kind, content });
        return { id: 'm', sessionId, role, kind, content, createdAt: 1 };
      },
      listSessions: () => [],
      createSession: () => session,
      deleteSession: () => {},
      renameSession: () => {},
      touchSession: () => {},
      listMessages: () => [],
      deleteMessages: () => {},
    } as unknown as AgentRepo,
  };
}

function makeService(
  host: FakeHost,
  repo: AgentRepo,
): AgentService & { __emitWindow: unknown[] } {
  const emitted: unknown[] = [];
  const service = new AgentService({
    repo,
    host: host as unknown as AgentHost,
    getSettings: () => ({}) as never,
    getWindow: () => ({ webContents: { send: (_c: string, p: unknown) => emitted.push(p) } }) as never,
  }) as AgentService & { __emitWindow: unknown[] };
  (service as unknown as { __emitWindow: unknown[] }).__emitWindow = emitted;
  return service;
}

describe('AgentService 多回合事件不重复累积', () => {
  let host: FakeHost;
  let svc: AgentService & { __emitWindow: unknown[] };
  let mr: ReturnType<typeof makeRepo>;
  const wait = () => new Promise((r) => setTimeout(r, 10));

  beforeEach(() => {
    host = makeHost();
    mr = makeRepo();
    svc = makeService(host, mr.repo);
  });

  it('连续两回合，assistant 文本只落库一次（旧 listener 不残留）', async () => {
    await svc.sendMessage('s1', '第一轮');
    host.emitTurn('dsh-s1');
    await wait();
    expect(mr.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);

    // 回合在 idle+finished 后已注销监听。
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(0);

    await svc.sendMessage('s1', '第二轮');
    host.emitTurn('dsh-s1');
    await wait();

    const assistant = mr.messages.filter((m) => m.role === 'assistant');
    // 两回合各一条，而非因残留 listener 导致第二轮重复成多条。
    expect(assistant).toHaveLength(2);
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(0);
  });

  it('新回合开始前会注销上一回合残留 listener（即使未等 idle 再发）', async () => {
    // 第一回合 sendMessage 但尚未 emitTurn（listener 仍在 active）。
    await svc.sendMessage('s1', '第一轮');
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(1);

    // 第二回合 sendMessage 前置注销旧 listener，再注册新的 → active 保持 1。
    await svc.sendMessage('s1', '第二轮');
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(1);

    // 只派发第二回合的事件 → 只有新 listener 收到，旧 listener 不再重复处理。
    host.emitTurn('dsh-s1');
    await wait();
    const assistant = mr.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
  });

  it('deleteSession 注销监听并清空流状态', async () => {
    await svc.sendMessage('s1', '第一轮');
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(1);

    svc.deleteSession('s1');
    expect(host.active.get('dsh-s1')?.size ?? 0).toBe(0);
    // 之后宿主再派发该会话事件不应再被处理（监听已全部注销）。
    host.emitRaw('dsh-s1', { kind: 'text-delta', text: '孤儿事件' });
    await wait();
    expect(mr.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('工具循环多 step：每 step 的 assistant-message 各自落库，不重复累积', async () => {
    // dsh 真实行为：一次用户消息 = 1 turn，工具循环 = 多个 step，
    // 每个 step 都以 finish chunk 结束并紧随一条 assistant/message 完整消息。
    // 旧实现按 finish 时刻的累积文本落库 → step2 会把 step1+step2 的文本重复落库。
    await svc.sendMessage('s1', '带工具的一轮');
    const listeners = [...(host.active.get('dsh-s1') ?? [])];
    const emit = (e: unknown) => listeners.forEach((l) => l(e));

    // step1：先思考、输出中间文本（如调用工具前的说明）。
    emit({ kind: 'status', status: 'running' });
    emit({ kind: 'reasoning-delta', text: '需要先检索文献' });
    emit({ kind: 'text-delta', text: '我先查一下文献。' });
    emit({ kind: 'finish', reason: 'stop' });
    emit({ kind: 'assistant-message', text: '我先查一下文献。', reasoning: '需要先检索文献' });
    // step2：最终答复（新 step 的 chunk 流）。
    emit({ kind: 'text-delta', text: '第一章结论是 X。' });
    emit({ kind: 'finish', reason: 'stop' });
    emit({ kind: 'assistant-message', text: '第一章结论是 X。', reasoning: '' });
    emit({ kind: 'status', status: 'idle' });
    await wait();

    const texts = mr.messages
      .filter((m) => m.role === 'assistant' && m.kind === 'text')
      .map((m) => m.content);
    const reasoning = mr.messages.filter((m) => m.role === 'assistant' && m.kind === 'reasoning').map((m) => m.content);

    // 两条彼此独立的文本消息，而非「step1 落 A、step2 落 A+B」的重复累积。
    expect(texts).toEqual(['我先查一下文献。', '第一章结论是 X。']);
    expect(reasoning).toEqual(['需要先检索文献']);
    // 任何一条消息都不许出现跨 step 拼接的重复内容。
    for (const t of texts) {
      expect(t).not.toContain('我先查一下文献。第一章结论是 X。');
      expect(t).not.toContain('第一章结论是 X。我先查一下文献。');
    }
  });

  it('assistant-message 与 finish 顺序：message 在 finish 后到达也不影响落库', async () => {
    // 防回归：assistant/message 一定晚于本 step 的 finish chunk 到达
    // （agent-loop 先推完 chunk 流、再 settle 完整消息）。
    await svc.sendMessage('s1', '顺序测试');
    const listeners = [...(host.active.get('dsh-s1') ?? [])];
    const emit = (e: unknown) => listeners.forEach((l) => l(e));
    emit({ kind: 'status', status: 'running' });
    // 只有 finish、没有 assistant-message（理论异常路径）：不应落库半截文本。
    emit({ kind: 'text-delta', text: '半截话' });
    emit({ kind: 'finish', reason: 'stop' });
    emit({ kind: 'status', status: 'idle' });
    await wait();
    expect(mr.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
