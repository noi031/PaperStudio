// agent 编排服务：连接 dsh 引擎（AgentHost）、会话仓储（AgentRepo）与渲染进程。
// 负责消息落库、事件累积与 webContents 转发。
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AgentRepo, AgentSession } from './agentRepo';
import type { AgentHost, AgentEvent } from './agentHost';
import type { PaperSettings } from '../shared/types.js';

export interface AgentServiceOptions {
  repo: AgentRepo;
  host: AgentHost;
  getSettings: () => PaperSettings;
  getWindow: () => BrowserWindow | null;
}

interface StreamState {
  text: string;
  reasoning: string;
  tool: { name: string; args: string } | null;
  finished: boolean;
}

export class AgentService {
  private streams = new Map<string, StreamState>();
  /** sessionId → 当前回合 dsh 事件监听注销函数；新回合/结束/删除时注销，防重复累积。 */
  private streamOffs = new Map<string, () => void>();
  private started = false;
  private version = '';
  private mcpEntry = '';
  /** in-flight 启动 promise：并发 ensureStarted 共享同一次启动，防重复 spawn。 */
  private starting: Promise<string> | null = null;

  constructor(private readonly opts: AgentServiceOptions) {}

  /** 注入论文域 MCP server 的 stdio 入口（编译产物路径），启动 dsh 前调用。 */
  setMcpEntry(entry: string): void {
    this.mcpEntry = entry;
  }

  /** 确保 dsh 引擎已启动（幂等 + 并发安全）。 */
  async ensureStarted(): Promise<string> {
    if (this.started && this.opts.host.ready) return this.version;
    if (!this.starting) {
      this.starting = this.opts.host
        .start(this.mcpEntry)
        .then((v) => {
          this.version = v;
          this.started = true;
          return v;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  health(): { ok: boolean; version?: string; message?: string } {
    if (this.started && this.opts.host.ready)
      return { ok: true, version: this.version };
    return { ok: false, message: this.started ? 'dsh 引擎未就绪' : 'dsh 引擎未启动（P2 后可用）' };
  }

  listSessions(): AgentSession[] {
    return this.opts.repo.listSessions();
  }

  createSession(title: string, context: string): AgentSession {
    const s = this.opts.repo.createSession(title, randomUUID(), JSON.stringify({ context }));
    // 带上下文的会话（如「发送到助手」）：首条消息即上下文，发给 dsh 作为会话起点。
    if (context) {
      void this.sendMessage(s.id, context).catch((err) => {
        this.emitToWindow({
          type: 'error',
          sessionId: s.id,
          message: `上下文注入失败：${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }
    return s;
  }

  deleteSession(id: string): void {
    this.opts.repo.deleteSession(id);
    this.streams.delete(id);
    this.streamOffs.get(id)?.();
    this.streamOffs.delete(id);
  }

  listMessages(sessionId: string) {
    return this.opts.repo.listMessages(sessionId);
  }

  /** 发一条用户消息：落库 → 送 dsh → 订阅事件流（累积 + 转发 + 落库）。 */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.opts.repo.getSession(sessionId);
    if (!session) throw new Error('会话不存在');

    await this.ensureStarted();

    const userMsg = this.opts.repo.appendMessage(sessionId, 'user', 'text', text);
    this.emitToWindow({
      type: 'message',
      sessionId,
      message: userMsg,
    });

    const st: StreamState = { text: '', reasoning: '', tool: null, finished: false };
    this.streams.set(sessionId, st);

    // 注销上一回合残留监听：旧 listener 闭包持有旧 StreamState，若不注销，
    // 新回合每个事件会同时触发所有累积 listener，流式输出按倍数重复。
    this.streamOffs.get(sessionId)?.();
    const off = this.opts.host.on(session.dshSessionId, (e) => {
      void this.handleEvent(sessionId, e, st);
    });
    this.streamOffs.set(sessionId, off);
    try {
      await this.opts.host.sendMessage(session.dshSessionId, text);
    } catch (err) {
      off();
      this.streamOffs.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      this.streams.delete(sessionId);
      this.emitToWindow({ type: 'error', sessionId, message: msg });
      throw err;
    }
  }

  private async handleEvent(sessionId: string, e: AgentEvent, st: StreamState): Promise<void> {
    const push = (kind: string, content: string, role: 'assistant' | 'user' | 'system' = 'assistant') => {
      const m = this.opts.repo.appendMessage(sessionId, role, kind, content);
      this.emitToWindow({ type: 'message', sessionId, message: m });
    };

    switch (e.kind) {
      case 'status':
        this.emitToWindow({ type: 'status', sessionId, status: e.status });
        if (e.status === 'idle' && st.finished) {
          this.streams.delete(sessionId);
          this.streamOffs.get(sessionId)?.();
          this.streamOffs.delete(sessionId);
        }
        break;
      case 'title':
        this.opts.repo.renameSession(sessionId, e.title || '未命名会话');
        this.emitToWindow({ type: 'title', sessionId, title: e.title });
        break;
      case 'user':
        // 回显 dsh 侧注入的用户消息（含 runtime context 时不重复落库）。
        break;
      case 'text-delta':
        st.text += e.text;
        this.emitToWindow({ type: 'delta', sessionId, kind: 'text', text: e.text });
        break;
      case 'reasoning-delta':
        st.reasoning += e.text;
        this.emitToWindow({ type: 'delta', sessionId, kind: 'reasoning', text: e.text });
        break;
      case 'tool-call':
        st.tool = { name: e.name, args: e.args };
        this.emitToWindow({ type: 'tool', sessionId, name: e.name, args: e.args });
        break;
      case 'tool-result':
        this.emitToWindow({ type: 'tool-result', sessionId, name: e.name, ok: e.ok });
        break;
      case 'finish':
        st.finished = true;
        // 落库统一走 assistant/message（dsh 每 step 一条完整消息，紧随 finish chunk 到达）。
        // finish 本身不落库：工具循环里每个 step 都以 finish 结束，若按此刻累积文本落库，
        // 跨 step 会重复落库成「越来越长」的重复回复。清空累积避免误用。
        st.reasoning = '';
        st.text = '';
        this.emitToWindow({ type: 'finish', sessionId, reason: e.reason });
        break;
      case 'assistant-message': {
        // dsh 每 step 一条完整消息：先 reasoning 后 text（与 chunk 流顺序一致），
        // 内容是 dsh 组装好的 blocks，整回合落库次数由 dsh 保证（每 step 恰好一次）。
        if (e.reasoning) push('reasoning', e.reasoning);
        if (e.text) push('text', e.text);
        break;
      }
      case 'error':
        this.emitToWindow({ type: 'error', sessionId, message: e.message });
        break;
    }
  }

  private emitToWindow(payload: unknown): void {
    this.opts.getWindow()?.webContents.send('agent:event', payload);
  }

  /** 关闭 dsh 引擎（应用退出时）。 */
  async dispose(): Promise<void> {
    this.started = false;
    this.streams.clear();
    for (const off of this.streamOffs.values()) off();
    this.streamOffs.clear();
    await this.opts.host.close();
  }
}
