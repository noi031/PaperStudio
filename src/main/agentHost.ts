// Echo 代理宿主：原 dsh（deepseek-harness）引擎宿主，现已整体替换为 Echo 平台能力网关。
//
// 旧链路：spawn dsh 子进程 → stdio 行分帧 JSON-RPC（initialize / session/prompt）
//         → session.event 通知 → 归一化 AgentEvent。
// 新链路：ECHO_CAP sub_agent.send（投递用户消息）+ sub_agent.query（轮询轮次 sections）
//         → 归一化为同一组 AgentEvent。
//
// 对上层保持不变：AgentEvent 形状与 AgentHost 的 ready / start / on / sendMessage /
// cancel / close 语义不变，因此 agentService、ipc、渲染进程无需改动。
//
// 与 dsh 的语义差异（详见 docs/echocap-接入验证.md）：
//  - 会话标识：原 dshSessionId 现作为 sub-agent 的 context_path（/sub-agent/paperstudio/<id>）。
//  - 论文域 MCP 工具不再注入引擎；代理侧使用平台自带工具集（mcpEntry 参数保留但忽略）。
//  - 引擎由平台托管：本进程不再持有子进程，也不再持有任何 LLM 凭证。
//  - 平台不返回增量正文段落（只有 sections 的完整文本），因此delta 由「本次查询相对上次
//    查询的文本增量」推导，UI 流式观感与逐字累积落库行为保持一致。
import type { PaperSettings } from '../shared/types.js';
import { echoCapStatus, subAgentQuery, subAgentSend, type SubAgentMessage } from './echoCap.js';

/** 归一化后推给 UI 的事件（agentService 再负责落库与转发渲染进程）。 */
export type AgentEvent =
  | { kind: 'status'; status: 'running' | 'idle' }
  | { kind: 'title'; title: string }
  | { kind: 'user'; text: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-call'; name: string; args: string }
  | { kind: 'tool-result'; name: string; ok: boolean }
  | { kind: 'finish'; reason: string }
  | { kind: 'assistant-message'; text: string; reasoning: string }
  | { kind: 'error'; message: string };

export interface AgentHostOptions {
  /** 兼容保留（原为 dsh 工作区 cwd，EchoCap 下不再使用）。 */
  appRoot?: string;
  /** 兼容保留（原为写 dsh-mcp.patch.yml 的目录，EchoCap 下不再使用）。 */
  userDataDir?: string;
  /** 兼容保留：EchoCap 由平台鉴权，此回调仅用于下游读取业务设置。 */
  settings?: () => PaperSettings;
  /** 兼容保留（原 dsh stderr 行回调）。 */
  onStderrLine?: (line: string) => void;
  /** 原始事件行回调（调试用）。 */
  onRawLine?: (line: string) => void;
  /** 宿主日志回调（调试用）。 */
  onLog?: (line: string) => void;
  /** 轮次轮询间隔（ms）。 */
  pollMs?: number;
}

/** sub-agent 会话路径前缀。 */
const CONTEXT_PREFIX = '/sub-agent/paperstudio/';
const DEFAULT_POLL_MS = 400;
/** 视为「回合已结束」的 message.status 取值。 */
const TERMINAL_STATUS = new Set([
  'completed',
  'success',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'interrupted',
  'stopped',
]);

interface SectionCursor {
  content: number;
  reasoning: number;
  tool: string | null;
  toolResult: boolean;
}

interface TurnState {
  seq: number;
  cancelled: boolean;
  cursors: Map<number, SectionCursor>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AgentHost {
  private initialized = false;
  private listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  private turns = new Map<string, TurnState>();
  private readonly pollMs: number;

  constructor(private readonly opts: AgentHostOptions = {}) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  /** 代理是否已就绪（已 start 且 EchoCap 可达）。 */
  get ready(): boolean {
    return this.initialized && echoCapStatus().ok;
  }

  /** 会话标识 → sub-agent context_path（已是路径则原样使用）。 */
  static contextPathFor(sessionId: string): string {
    return sessionId.startsWith('/') ? sessionId : CONTEXT_PREFIX + sessionId;
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
    this.opts.onRawLine?.(line);
  }

  /**
   * 「启动引擎」：校验 EchoCap 可达并返回引擎版本串。
   * 失败抛错且可重试（与 dsh 版一致），错误信息给出缺失项（socket / 鉴权 key）。
   */
  async start(_mcpEntry?: string): Promise<string> {
    // 只重置回合状态，不清空事件监听：调用方可能在 start 之前就已 on()，
    // 清监听只应发生在 close()（应用退出）。
    for (const turn of this.turns.values()) turn.cancelled = true;
    this.turns.clear();
    const st = echoCapStatus();
    if (!st.ok) {
      this.initialized = false;
      throw new Error(`EchoCap 不可用：${st.message}`);
    }
    this.initialized = true;
    return `echocap/${process.env.ECHO_SSH_ENV_ID || 'local'}`;
  }

  on(sessionId: string, listener: (e: AgentEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  private emit(sessionId: string, e: AgentEvent): void {
    this.listeners.get(sessionId)?.forEach((l) => l(e));
  }

  private broadcast(e: AgentEvent): void {
    for (const set of this.listeners.values()) for (const l of set) l(e);
  }

  /** 向指定会话发一条消息（不等待回合结束，事件走 on()）。 */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const ctx = AgentHost.contextPathFor(sessionId);
    const st = echoCapStatus();
    if (!st.ok) {
      const message = `EchoCap 不可用：${st.message}`;
      this.emit(sessionId, { kind: 'error', message });
      throw new Error(message);
    }

    // 新回合接管：旧回合的轮询立即停止（与 dsh 下「新 prompt 顶掉旧回合转发」一致）。
    const prev = this.turns.get(sessionId);
    if (prev) prev.cancelled = true;

    const turn: TurnState = { seq: 0, cancelled: false, cursors: new Map() };
    this.turns.set(sessionId, turn);
    this.emit(sessionId, { kind: 'status', status: 'running' });

    let res;
    try {
      res = await subAgentSend(ctx, text, 0);
    } catch (err) {
      this.turns.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      this.emit(sessionId, { kind: 'error', message });
      this.emit(sessionId, { kind: 'status', status: 'idle' });
      throw err;
    }

    turn.seq = res.seq;
    this.log(`[AgentHost] turn accepted ctx=${ctx} seq=${res.seq} status=${res.status}`);
    void this.pump(sessionId, ctx, turn);
  }

  /** 轮询轮次 sections，把文本/推理/tool 增量归一化为 AgentEvent。 */
  private async pump(sessionId: string, ctx: string, turn: TurnState): Promise<void> {
    try {
      for (;;) {
        await delay(this.pollMs);
        if (turn.cancelled) return;

        let msg: SubAgentMessage | undefined;
        try {
          const res = await subAgentQuery(ctx, turn.seq);
          msg = res.messages?.find((m) => m.seq === turn.seq) ?? res.messages?.[res.messages.length - 1];
        } catch (err) {
          if (turn.cancelled) return;
          this.emit(sessionId, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
          this.emit(sessionId, { kind: 'status', status: 'idle' });
          return;
        }
        if (!msg) continue;
        if (turn.cancelled) return;

        this.emitSections(sessionId, turn, msg);

        const status = String(msg.status ?? '');
        if (TERMINAL_STATUS.has(status)) {
          if (status === 'failed' || status === 'error') {
            this.emit(sessionId, { kind: 'error', message: msg.error?.message || '代理回合执行失败' });
          }
          const text = collect(msg, 'content');
          const reasoning = collect(msg, 'reasoning');
          // 落库统一走 assistant-message（与 dsh 版一致：每回合恰好一条完整消息）。
          if (text || reasoning) this.emit(sessionId, { kind: 'assistant-message', text, reasoning });
          this.emit(sessionId, { kind: 'finish', reason: msg.stop_reason || status });
          this.emit(sessionId, { kind: 'status', status: 'idle' });
          return;
        }
      }
    } finally {
      if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
    }
  }

  /** 按 sub_seq 游标比对，只发新增部分（文本/推理）与首见的 tool 事件。 */
  private emitSections(sessionId: string, turn: TurnState, msg: SubAgentMessage): void {
    for (const sec of msg.sections ?? []) {
      let cur = turn.cursors.get(sec.sub_seq);
      if (!cur) {
        cur = { content: 0, reasoning: 0, tool: null, toolResult: false };
        turn.cursors.set(sec.sub_seq, cur);
      }
      if (sec.type === 'reasoning' && sec.reasoning) {
        if (sec.reasoning.length > cur.reasoning) {
          this.emit(sessionId, { kind: 'reasoning-delta', text: sec.reasoning.slice(cur.reasoning) });
          cur.reasoning = sec.reasoning.length;
        }
      } else if (sec.type === 'content' && sec.content) {
        if (sec.content.length > cur.content) {
          this.emit(sessionId, { kind: 'text-delta', text: sec.content.slice(cur.content) });
          cur.content = sec.content.length;
        }
      } else if (sec.type === 'tool') {
        const name = sec.toolname ?? '';
        if (name && cur.tool !== name) {
          cur.tool = name;
          this.emit(sessionId, { kind: 'tool-call', name, args: '' });
        }
        if (!cur.toolResult && sec.completed) {
          cur.toolResult = true;
          const raw = JSON.stringify(sec.tool_execution_state ?? '').toLowerCase();
          const ok = !raw.includes('fail') && !raw.includes('error');
          this.emit(sessionId, { kind: 'tool-result', name: name || 'tool', ok });
        }
      }
    }
  }

  /**
   * 打断会话当前回合：停止本地轮询与事件转发。
   * 平台 sub_agent 未提供回合级取消 RPC，因此仅本地生效（调用方在 stop() 中会轮换
   * context_path，下一条消息走新会话，行为与 dsh 版一致）。
   */
  async cancel(sessionId: string): Promise<void> {
    const turn = this.turns.get(sessionId);
    if (turn) turn.cancelled = true;
    this.turns.delete(sessionId);
  }

  async close(): Promise<void> {
    this.initialized = false;
    for (const turn of this.turns.values()) turn.cancelled = true;
    this.turns.clear();
    this.listeners.clear();
  }

  /** 广播一条错误（供上层外部异常时使用）。 */
  emitError(message: string): void {
    this.broadcast({ kind: 'error', message });
  }
}

/** 按 sub_seq 顺序拼接某类 section 的完整文本。 */
function collect(msg: SubAgentMessage, type: 'content' | 'reasoning'): string {
  return (msg.sections ?? [])
    .filter((s) => s.type === type)
    .map((s) => (type === 'content' ? s.content ?? '' : s.reasoning ?? ''))
    .join('');
}
