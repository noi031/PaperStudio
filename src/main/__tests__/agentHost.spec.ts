// agentHost.ts 协议映射单测：把 dsh 原始 JSON-RPC 通知归一化为 AgentEvent。
// 通过 (host as any).dispatch() 注入协议帧，验证事件路由与载荷提取。
import { describe, it, expect } from 'vitest';
import { AgentHost } from '../agentHost';

function makeHost() {
  const host = new AgentHost({
    appRoot: '.',
    userDataDir: '.',
    settings: () => ({}) as never,
  });
  return host;
}

function collect(host: AgentHost, sessionId: string) {
  const events: unknown[] = [];
  (host as unknown as { on: (s: string, l: (e: unknown) => void) => void }).on(sessionId, (e) => events.push(e));
  return events;
}

describe('AgentHost 协议映射', () => {
  it('session.status → status 事件', () => {
    const host = makeHost();
    const events = collect(host, 's1');
    (host as unknown as { dispatch: (n: { method: string; params: object }) => void }).dispatch({
      method: 'session.status',
      params: { sessionId: 's1', status: 'idle' },
    });
    expect(events).toEqual([{ kind: 'status', status: 'idle' }]);
  });

  it('assistant/chunk 的 text/reasoning/finish 分派', () => {
    const host = makeHost();
    const events = collect(host, 's1');
    const dispatch = (n: { method: string; params: object }) =>
      (host as unknown as { dispatch: (m: { method: string; params: object }) => void }).dispatch(n);
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } } },
    });
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'think' } } } },
    });
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'assistant/chunk', data: { chunk: { type: 'finish', reason: { kind: 'stop' } } } } },
    });
    expect(events).toEqual([
      { kind: 'text-delta', text: 'hi' },
      { kind: 'reasoning-delta', text: 'think' },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('tool/call 与 tool/result（含失败分支）', () => {
    const host = makeHost();
    const events = collect(host, 's1');
    const dispatch = (n: { method: string; params: object }) =>
      (host as unknown as { dispatch: (m: { method: string; params: object }) => void }).dispatch(n);
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'tool/call', data: { name: 'mcp__paper__echo', arguments: '{"text":"x"}' } } },
    });
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'tool/result', data: { message: { name: 'mcp__paper__echo' } } } },
    });
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'tool/result', data: { error: { name: 'EchoFailed' } } } },
    });
    expect(events).toEqual([
      { kind: 'tool-call', name: 'mcp__paper__echo', args: '{"text":"x"}' },
      { kind: 'tool-result', name: 'mcp__paper__echo', ok: true },
      { kind: 'tool-result', name: 'EchoFailed', ok: false },
    ]);
  });

  it('session/title 与 user/message', () => {
    const host = makeHost();
    const events = collect(host, 's1');
    const dispatch = (n: { method: string; params: object }) =>
      (host as unknown as { dispatch: (m: { method: string; params: object }) => void }).dispatch(n);
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'session/title', data: { title: '论文调研' } } },
    });
    dispatch({
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } } },
    });
    expect(events).toEqual([
      { kind: 'title', title: '论文调研' },
      { kind: 'user', text: '你好' },
    ]);
  });

  it('未知方法与缺字段事件被忽略', () => {
    const host = makeHost();
    const events = collect(host, 's1');
    const dispatch = (n: { method: string; params: object }) =>
      (host as unknown as { dispatch: (m: { method: string; params: object }) => void }).dispatch(n);
    dispatch({ method: 'unknown/thing', params: { sessionId: 's1' } });
    dispatch({ method: 'session.event', params: { sessionId: 's1', event: { type: 'assistant/chunk', data: {} } } });
    dispatch({ method: 'session.event', params: { sessionId: 's1', event: { type: 'whatever', data: {} } } });
    expect(events).toEqual([]);
  });

  it('事件按 sessionId 隔离', () => {
    const host = makeHost();
    const a = collect(host, 'a');
    const b = collect(host, 'b');
    const dispatch = (n: { method: string; params: object }) =>
      (host as unknown as { dispatch: (m: { method: string; params: object }) => void }).dispatch(n);
    dispatch({ method: 'session.status', params: { sessionId: 'a', status: 'running' } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});
