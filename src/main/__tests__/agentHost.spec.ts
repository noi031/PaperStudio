// agentHost.ts 协议映射单测：把 EchoCap sub_agent 轮次的 sections 归一化为 AgentEvent。
// echoCap 模块被 mock：单测不触网，只验证映射与回合生命周期。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cap = vi.hoisted(() => ({
  status: vi.fn(),
  send: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../echoCap.js', () => ({
  echoCapStatus: cap.status,
  subAgentSend: cap.send,
  subAgentQuery: cap.query,
}));

import { AgentHost, type AgentEvent } from '../agentHost';

function makeHost(pollMs = 1) {
  return new AgentHost({
    appRoot: '.',
    userDataDir: '.',
    settings: () => ({}) as never,
    pollMs,
  });
}

function collect(host: AgentHost, sessionId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  host.on(sessionId, (e) => events.push(e));
  return events;
}

function section(over: Record<string, unknown> = {}) {
  return {
    sub_seq: 1,
    type: 'content',
    completed: true,
    reasoning: null,
    content: null,
    toolname: null,
    tool_execution_state: null,
    has_summary: false,
    summary: null,
    ...over,
  };
}

function message(sections: unknown[], over: Record<string, unknown> = {}) {
  return {
    seq: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'running',
    stop_reason: null,
    error: null,
    usermsg: null,
    sections,
    ...over,
  };
}

const waitIdle = (events: AgentEvent[]) =>
  vi.waitFor(() => expect(events.some((e) => e.kind === 'status' && e.status === 'idle')).toBe(true));

beforeEach(() => {
  cap.status.mockReturnValue({ ok: true });
  cap.send.mockReset();
  cap.query.mockReset();
});

describe('AgentHost ↔ EchoCap 协议映射', () => {
  it('context_path 映射：dshSessionId → sub-agent 会话路径', () => {
    expect(AgentHost.contextPathFor('abc-123')).toBe('/sub-agent/paperstudio/abc-123');
    expect(AgentHost.contextPathFor('/sub-agent/x')).toBe('/sub-agent/x');
  });

  it('EchoCap 不可用时 start 抛错、ready 为 false', async () => {
    cap.status.mockReturnValue({ ok: false, message: 'socket 缺失' });
    const host = makeHost();
    await expect(host.start()).rejects.toThrow(/EchoCap 不可用/);
    expect(host.ready).toBe(false);
  });

  it('EchoCap 可用时 start 返回引擎版本串', async () => {
    const host = makeHost();
    await expect(host.start()).resolves.toMatch(/^echocap\//);
    expect(host.ready).toBe(true);
  });

  it('回合生命周期：running → 文本增量 → 完整消息 → finish → idle', async () => {
    cap.send.mockResolvedValue({ seq: 7, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query
      .mockResolvedValueOnce({ messages: [message([section({ content: 'h' })], { seq: 7 })] })
      .mockResolvedValueOnce({
        messages: [message([section({ content: 'hi' })], { seq: 7, status: 'completed', stop_reason: 'stop' })],
      });

    const host = makeHost();
    const events = collect(host, 's1');
    await host.sendMessage('s1', '你好');
    await waitIdle(events);

    expect(cap.send).toHaveBeenCalledWith('/sub-agent/paperstudio/s1', '你好', 0);
    expect(cap.query).toHaveBeenCalledWith('/sub-agent/paperstudio/s1', 7);
    expect(events).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'text-delta', text: 'h' },
      { kind: 'text-delta', text: 'i' },
      { kind: 'assistant-message', text: 'hi', reasoning: '' },
      { kind: 'finish', reason: 'stop' },
      { kind: 'status', status: 'idle' },
    ]);
  });

  it('reasoning 与 content 分段各自累计、互不串扰', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockResolvedValueOnce({
      messages: [
        message(
          [
            section({ sub_seq: 1, type: 'reasoning', reasoning: '想' }),
            section({ sub_seq: 2, type: 'content', content: '答' }),
          ],
          { status: 'completed', stop_reason: 'stop' },
        ),
      ],
    });

    const host = makeHost();
    const events = collect(host, 's1');
    await host.sendMessage('s1', 'q');
    await waitIdle(events);

    expect(events).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'reasoning-delta', text: '想' },
      { kind: 'text-delta', text: '答' },
      { kind: 'assistant-message', text: '答', reasoning: '想' },
      { kind: 'finish', reason: 'stop' },
      { kind: 'status', status: 'idle' },
    ]);
  });

  it('tool section → tool-call + tool-result（含失败态判定）', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockResolvedValueOnce({
      messages: [
        message(
          [
            section({ sub_seq: 1, type: 'tool', toolname: 'web_search', tool_execution_state: 'completed' }),
            section({ sub_seq: 2, type: 'tool', toolname: 'read_file', tool_execution_state: 'failed' }),
          ],
          { status: 'completed' },
        ),
      ],
    });

    const host = makeHost();
    const events = collect(host, 's1');
    await host.sendMessage('s1', 'q');
    await waitIdle(events);

    expect(events.filter((e) => e.kind === 'tool-call' || e.kind === 'tool-result')).toEqual([
      { kind: 'tool-call', name: 'web_search', args: '' },
      { kind: 'tool-result', name: 'web_search', ok: true },
      { kind: 'tool-call', name: 'read_file', args: '' },
      { kind: 'tool-result', name: 'read_file', ok: false },
    ]);
  });

  it('回合失败：emit error 且仍然收尾（finish + idle）', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockResolvedValueOnce({
      messages: [message([section({ content: '部分' })], { status: 'failed', error: { message: '上游超时' } })],
    });

    const host = makeHost();
    const events = collect(host, 's1');
    await host.sendMessage('s1', 'q');
    await waitIdle(events);

    expect(events).toContainEqual({ kind: 'error', message: '上游超时' });
    expect(events).toContainEqual({ kind: 'finish', reason: 'failed' });
  });

  it('轮询失败：emit error + idle，不再继续轮询', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockRejectedValue(new Error('socket 断开'));

    const host = makeHost();
    const events = collect(host, 's1');
    await host.sendMessage('s1', 'q');
    await waitIdle(events);

    expect(events).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'error', message: 'socket 断开' },
      { kind: 'status', status: 'idle' },
    ]);
  });

  it('send 失败：抛错并 emit error + idle', async () => {
    cap.send.mockRejectedValue(new Error('ECHO_CAP 连接失败'));
    const host = makeHost();
    const events = collect(host, 's1');
    await expect(host.sendMessage('s1', 'q')).rejects.toThrow(/ECHO_CAP 连接失败/);
    expect(events).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'error', message: 'ECHO_CAP 连接失败' },
      { kind: 'status', status: 'idle' },
    ]);
  });

  it('cancel 停止轮询，之后不再产生事件', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockResolvedValue({ messages: [message([section({ content: 'x' })])] });

    const host = makeHost(10);
    const events = collect(host, 's1');
    await host.sendMessage('s1', 'q');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(1));
    await host.cancel('s1');
    const snapshot = events.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(events.length).toBe(snapshot);
  });

  it('事件按 sessionId 隔离，close 清理监听', async () => {
    const host = makeHost();
    const a = collect(host, 'a');
    const b = collect(host, 'b');
    host.emitError('boom');
    expect(a).toEqual([{ kind: 'error', message: 'boom' }]);
    expect(b).toHaveLength(1);
    await host.close();
    expect(host.ready).toBe(false);
    expect(a).toHaveLength(1);
  });

  it('start 不清空 start 之前注册的监听（sendMessage 仍能送达）', async () => {
    cap.send.mockResolvedValue({ seq: 1, status: 'running', done: false, context_path: '/x', turn_request_id: 't' });
    cap.query.mockResolvedValueOnce({
      messages: [message([section({ content: 'ok' })], { status: 'completed' })],
    });
    const host = makeHost();
    const events = collect(host, 's1');
    await host.start();
    await host.sendMessage('s1', 'q');
    await waitIdle(events);
    expect(events[0]).toEqual({ kind: 'status', status: 'running' });
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' });
  });

});
