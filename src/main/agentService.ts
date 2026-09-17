// agent 编排服务：连接 AI 代理宿主（AgentHost，dsh 引擎或 EchoCap 代理）、
// 会话仓储（AgentRepo）与渲染进程。负责消息落库、事件累积与事件转发
// （Electron: webContents.send；Web 版: SSE 广播，经 HostEmit 抽象）。
import { randomUUID } from 'node:crypto';
import type { AgentRepo, AgentSession } from './agentRepo';
import type { AgentHost, AgentEvent } from './agentHost';
import type { HostEmit } from './ipc';
import { backendLabel, resolveBackend } from './backend';
import type { PaperSettings } from '../shared/types.js';

export interface AgentServiceOptions {
  repo: AgentRepo;
  host: AgentHost;
  getSettings: () => PaperSettings;
  /** 事件发射器（Electron: webContents.send；Web: SSE 广播）。 */
  emit: HostEmit;
}

interface StreamState {
  text: string;
  reasoning: string;
  tool: { name: string; args: string } | null;
  finished: boolean;
}

export class AgentService {
  private streams = new Map<string, StreamState>();
  /** sessionId → 当前回合宿主事件监听注销函数；新回合/结束/删除时注销，防重复累积。 */
  private streamOffs = new Map<string, () => void>();
  private started = false;
  private version = '';
  private mcpEntry = '';
  /** in-flight 启动 promise：并发 ensureStarted 共享同一次启动，防重复拉起。 */
  private starting: Promise<string> | null = null;
  /** 宿主启动后已被轮换会话 id 的会话：其首条消息需注入历史上下文（宿主侧记忆已丢）。 */
  private rotatedSessions = new Set<string>();

  constructor(private readonly opts: AgentServiceOptions) {}

  /** 注入论文域 MCP server 的 stdio 入口（编译产物路径），启动 dsh 前调用；echocap 下忽略。 */
  setMcpEntry(entry: string): void {
    this.mcpEntry = entry;
  }

  /** 确保代理宿主已启动（幂等 + 并发安全）。 */
  async ensureStarted(): Promise<string> {
    if (this.started && this.opts.host.ready) return this.version;
    if (!this.starting) {
      this.starting = this.opts.host
        .start(this.mcpEntry)
        .then((v) => {
          this.version = v;
          this.started = true;
          // 宿主（重新）启动：旧进程的会话 id 已全部失效，
          // 轮换为新 id（下次 prompt 走「新建会话」路径），并标记会话：首条消息注入历史。
          this.opts.repo.rotateAllDshSessionIds();
          for (const s of this.opts.repo.listSessions()) this.rotatedSessions.add(s.id);
          return v;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  health(): { ok: boolean; version?: string; message?: string } {
    if (this.started && this.opts.host.ready) return { ok: true, version: this.version };
    const label = backendLabel(resolveBackend(this.opts.getSettings));
    return { ok: false, message: this.started ? `${label}未就绪` : `${label}未启动` };
  }

  listSessions(): AgentSession[] {
    return this.opts.repo.listSessions();
  }

  createSession(title: string, context: string): AgentSession {
    const s = this.opts.repo.createSession(title, randomUUID(), JSON.stringify({ context }));
    // 带上下文的会话（如「发送到助手」）：首条消息即上下文，发给宿主作为会话起点。
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

  /** 发一条用户消息：落库 → 送宿主 → 订阅事件流（累积 + 转发 + 落库）。
   *  rotated 会话（宿主重启/打断后已换新会话 id）首条消息注入历史上下文，
   *  让新宿主会话能「接上」之前的对话。 */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    // 先确保宿主已启动：首次启动会轮换所有会话的会话 id，
    // 因此 session（含最新会话 id）必须在 ensureStarted 之后重新读取。
    await this.ensureStarted();

    const session = this.opts.repo.getSession(sessionId);
    if (!session) throw new Error('会话不存在');

    const userMsg = this.opts.repo.appendMessage(sessionId, 'user', 'text', text);
    this.emitToWindow({
      type: 'message',
      sessionId,
      message: userMsg,
    });

    // 轮换后的第一条消息：注入会话历史（DB 里有完整消息，落库 user 消息仍用原文）。
    let effective = text;
    if (this.rotatedSessions.has(sessionId)) {
      this.rotatedSessions.delete(sessionId);
      const history = this.buildHistoryContext(sessionId);
      if (history) effective = `${history}\n\n${text}`;
    }

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
      await this.opts.host.sendMessage(session.dshSessionId, effective);
    } catch (err) {
      off();
      this.streamOffs.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      this.streams.delete(sessionId);
      this.emitToWindow({ type: 'error', sessionId, message: msg });
      throw err;
    }
  }

  /** 组装会话历史摘要（最近若干条 user/assistant 消息），用于注入轮换后的新宿主会话。
   *  注意：刚落库的当前 user 消息已在数组末尾，需排除，避免历史里重复一遍。 */
  private buildHistoryContext(sessionId: string): string {
    const msgs = this.opts.repo.listMessages(sessionId);
    const recent = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // 排除当前消息
      .slice(-12)
      .map((m) => {
        const who = m.role === 'user' ? '用户' : '助手';
        const c = m.kind === 'reasoning' ? '' : m.content;
        return c ? `${who}：${c.slice(0, 400)}` : null;
      })
      .filter((x): x is string => !!x);
    if (recent.length === 0) return '';
    return `【以下是本会话此前的对话历史（宿主会话已重置，供你接续上下文）：】\n${recent.join('\n')}`;
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
        // 回显宿主侧注入的用户消息（含 runtime context 时不重复落库）。
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
        // 落库统一走 assistant/message（宿主每回合/每 step 一条完整消息）。
        // finish 本身不落库：工具循环里每个 step 都以 finish 结束，若按此刻累积文本落库，
        // 跨 step 会重复落库成「越来越长」的重复回复。清空累积避免误用。
        st.reasoning = '';
        st.text = '';
        this.emitToWindow({ type: 'finish', sessionId, reason: e.reason });
        break;
      case 'assistant-message': {
        // 每回合一条完整消息：先 reasoning 后 text（与 delta 流顺序一致），
        // 整回合落库次数由宿主保证（每回合/每 step 恰好一次）。
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
    this.opts.emit('agent:event', payload);
  }

  /**
   * 打断当前回合（Esc）：先尝试通知宿主 cancel，再清理本地流状态。
   * 注意：两种宿主对 session 级打断的支持都有限——dsh 本机 SDK 协议白名单无
   * session/cancel RPC，旧回合会在后台自然跑完并被丢弃（listener 已注销）；
   * echocap 平台无回合级取消 RPC，cancel 仅停止本地轮询。
   * 关键：打断后立即轮换该会话的会话 id——若复用旧 id，下一条消息会
   * 被宿主排队到旧回合跑完才执行（表现为「继续对话没回复」）。换新 id 后下一条
   * 消息走全新宿主会话立刻执行，并自动注入会话历史上下文（首条消息）。
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.opts.repo.getSession(sessionId);
    if (!session) return;
    try {
      await this.opts.host.cancel(session.dshSessionId);
    } catch (err) {
      // 宿主可能不支持取消：忽略错误，本地状态照常清理。
      console.warn('[AgentService] cancel 失败（宿主可能不支持）:', err instanceof Error ? err.message : err);
    }
    this.streams.delete(sessionId);
    this.streamOffs.get(sessionId)?.();
    this.streamOffs.delete(sessionId);
    // 轮换会话 id：下次 sendMessage 走新宿主会话，立即可回复；首条注入历史。
    this.opts.repo.rotateDshSessionId(sessionId);
    this.rotatedSessions.add(sessionId);
    // 通知渲染进程：回合被用户打断（收尾流式缓冲）。
    this.emitToWindow({ type: 'status', sessionId, status: 'idle' });
    this.emitToWindow({ type: 'finish', sessionId, reason: 'interrupted' });
  }

  /** 关闭代理宿主（应用退出时）。 */
  async dispose(): Promise<void> {
    this.started = false;
    this.streams.clear();
    for (const off of this.streamOffs.values()) off();
    this.streamOffs.clear();
    await this.opts.host.close();
  }
}
