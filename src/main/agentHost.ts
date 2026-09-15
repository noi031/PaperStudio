// dsh 引擎宿主：以子进程方式驱动 deepseek-harness SDK runtime，并把会话事件
// 归一化为 UI 层 AgentEvent。单一实例，被 agentService 持有。
// 传输层为自写 stdio 行分帧 JSON-RPC 客户端（协议见 docs/dsh-接入验证.md §2）：
// 裸 spawn 使 dsh 的 stderr 日志可见，便于排查 MCP/工具执行问题。
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { PaperSettings } from '../shared/types.js';

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

/** 协议层通知形状（session.event / session.status / subagent.*）。 */
interface WireNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface AgentHostOptions {
  /** 应用根（dsh 工作区 cwd + 定位 node_modules 里的 bin.js）。 */
  appRoot: string;
  /** userData 目录（写 dsh-mcp.patch.yml）。 */
  userDataDir: string;
  /** 启动时读取的 settings（取 llmApiKey / llmModel）。 */
  settings: () => PaperSettings;
  /** dsh stderr 行回调（调试/MCP 排查用；不传则丢弃）。 */
  onStderrLine?: (line: string) => void;
  /** 原始 stdout 行回调（调试用）。 */
  onRawLine?: (line: string) => void;
}

export class AgentHost {
  private child: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  private initialized = false;
  private stderrTail = '';

  constructor(private readonly opts: AgentHostOptions) {}

  /** dsh 是否已就绪（子进程活 + initialize 成功）。 */
  get ready(): boolean {
    return this.initialized && this.child !== null && this.child.exitCode === null;
  }

  private binPath(): string {
    return path.join(this.opts.appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  private patchPath(): string {
    return path.join(this.opts.userDataDir, 'dsh-mcp.patch.yml');
  }

  /** settings 是否配置了非官方 LLM 端点（此时走 llm-pi-ai 自定义路由）。 */
  private usesCustomEndpoint(): boolean {
    const baseUrl = this.opts.settings().llmBaseUrl?.trim();
    return !!baseUrl && baseUrl !== 'https://api.deepseek.com';
  }

  /** 生成 dsh `--patch` 文件：挂载论文域 MCP server（stdio）；settings 配了自定义
   *  LLM 端点时，同时注入 llm-pi-ai 自定义 provider 路由（dsh 默认只打官方端点）。 */
  private writePatch(mcpEntry: string): void {
    const s = this.opts.settings();
    const lines = [
      '- insert:',
      '    - id: mcp-paper',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: paper',
      '        transport: stdio',
      '        command: node',
      `        args: ['${mcpEntry}']`,
      '        toolCallTimeoutMs: 120000',
    ];
    // llmBaseUrl 非默认（官方）时，覆盖 dsh-base 已挂载的 llm-pi-ai（dormant）行，
    // 注册 OpenAI 兼容 provider 路由 custom；并覆盖 agent-default-model，让会话默认
    // 走 custom 路由（否则会话仍取 dsh 默认 deepseek-official 打官方端点）。
    // key 经 apiKeyEnv 引用，不落盘。
    const baseUrl = s.llmBaseUrl?.trim();
    const isDefault = !baseUrl || baseUrl === 'https://api.deepseek.com';
    if (!isDefault) {
      lines.push(
        '- id: llm-pi-ai',
        "  name: '@deepseek-ai/dsh-llm-pi-ai'",
        '  config:',
        '    providers:',
        '      custom:',
        '        displayName: PaperStudio LLM',
        '        apiKeyEnv: PAPERSTUDIO_LLM_API_KEY',
        '        api: openai-completions',
        `        baseURL: ${baseUrl}`,
        '        models:',
        `          - id: ${s.llmModel}`,
        `            contextWindow: ${s.llmContextWindow}`,
        '- id: agent-default-model',
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        '  config:',
        '    provider: custom',
        `    model: ${s.llmModel}`,
      );
    }
    fs.mkdirSync(this.opts.userDataDir, { recursive: true });
    fs.writeFileSync(this.patchPath(), lines.join('\n'), 'utf8');
  }

  /** 启动子进程 + initialize 握手。失败抛错，可重试（会先清理旧进程）。 */
  async start(mcpEntry: string): Promise<string> {
    const s = this.opts.settings();
    if (!s.llmApiKey) throw new Error('Settings 里未配置 LLM API Key');

    await this.close();

    this.writePatch(mcpEntry);

    const child = spawn(
      process.execPath,
      // --expose-internals：让 cordis-plugin-loader 走纯 JS require 拿 Node 内部 ESM loader。
      // 不加时它依赖 node-addon-require-builtin 原生 addon，在 Electron 的 RUN_AS_NODE
      // 模式下缺少 V8 符号（Unsupported/no-realm）取不到 loader，导致插件树把裸包名
      // 从顶层 node_modules 解析而找不到 dsh 嵌套插件包（ERR_MODULE_NOT_FOUND）。
      ['--expose-internals', this.binPath(), '--profile', 'sdk', '--patch', this.patchPath()],
      {
        cwd: this.opts.appRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 主进程里 process.execPath 是 electron.exe；用该变量让 dsh bin.js 以纯 Node 运行
          // （纯 Node 环境跑 verify 脚本时该变量被忽略）。
          ELECTRON_RUN_AS_NODE: '1',
          DEEPSEEK_API_KEY: s.llmApiKey,
          // 自定义端点 provider 的凭证引用（llm-pi-ai 路由 custom 的 apiKeyEnv）。
          PAPERSTUDIO_LLM_API_KEY: s.llmApiKey,
          DSH_HOME: process.env.DSH_HOME ?? path.join(this.opts.userDataDir, '.dsh'),
        },
        windowsHide: true,
      },
    );
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.stderrTail = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      this.buf += d;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        this.opts.onRawLine?.(line);
        try {
          const msg = JSON.parse(line) as
            | { id?: number; result?: unknown; error?: { message?: string } }
            | WireNotification;
          this.handleMessage(msg);
        } catch {
          // 非 JSON 行：忽略（dsh 不应向 stdout 写日志）。
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.opts.onStderrLine?.(d);
    });

    child.on('exit', (code) => {
      this.initialized = false;
      const err = new Error(
        `dsh 运行期已退出 (code ${code})${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-800)}` : ''}`,
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.broadcast({ kind: 'error', message: err.message });
    });

    const res = (await this.request('initialize', {
      cwd: this.opts.appRoot,
      // 自定义端点时用 llm-pi-ai 路由 custom；否则走 dsh 默认 deepseek-official。
      provider: this.usesCustomEndpoint() ? 'custom' : 'deepseek-official',
      model: s.llmModel,
      maxTokens: 8192,
    })) as { serverInfo?: { version?: string } };

    this.initialized = true;
    return res?.serverInfo?.version ?? 'unknown';
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC error'));
      else p.resolve(msg.result);
      return;
    }
    this.dispatch({ method: msg.method ?? '', params: msg.params ?? {} });
  }

  private request(method: string, params?: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!this.child || this.child.exitCode !== null || !stdin || !stdin.writable) {
        reject(new Error('dsh 子进程不可用'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  private dispatch(n: WireNotification): void {
    const params = n.params ?? {};
    if (n.method === 'session.status') {
      const sid = String(params.sessionId ?? '');
      const status = params.status as 'running' | 'idle';
      this.emit(sid, { kind: 'status', status });
      return;
    }
    if (n.method !== 'session.event') return;
    const sid = String(params.sessionId ?? '');
    const ev = params.event as { type: string; data: Record<string, unknown> };
    if (!ev?.type) return;
    switch (ev.type) {
      case 'session/title':
        this.emit(sid, { kind: 'title', title: String((ev.data as { title?: unknown }).title ?? '') });
        break;
      case 'user/message': {
        const data = ev.data as { content?: Array<{ type?: string; text?: string }> };
        const text = (data.content ?? [])
          .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
          .join('');
        this.emit(sid, { kind: 'user', text });
        break;
      }
      case 'assistant/chunk': {
        const chunk = ev.data.chunk as { type?: string; text?: string; reason?: { kind?: string } } | undefined;
        if (!chunk?.type) break;
        if (chunk.type === 'text-delta') this.emit(sid, { kind: 'text-delta', text: chunk.text ?? '' });
        else if (chunk.type === 'reasoning-delta') this.emit(sid, { kind: 'reasoning-delta', text: chunk.text ?? '' });
        else if (chunk.type === 'finish') this.emit(sid, { kind: 'finish', reason: chunk.reason?.kind ?? 'unknown' });
        break;
      }
      // dsh 每 step 一条完整 assistant 消息（内容为组装好的 blocks），
      // 是唯一可靠的落库来源：chunk finish 在工具循环里每个 step 都会发，
      // 若按 finish 时刻的累积文本落库，跨 step 会重复落库成「越来越长」的重复回复。
      case 'assistant/message': {
        const message = ev.data.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const text = (message?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        const reasoning = (message?.content ?? [])
          .filter((b) => b.type === 'reasoning')
          .map((b) => b.text ?? '')
          .join('');
        if (text || reasoning) this.emit(sid, { kind: 'assistant-message', text, reasoning });
        break;
      }
      case 'tool/call': {
        const data = ev.data as { name?: string; arguments?: string };
        this.emit(sid, { kind: 'tool-call', name: data.name ?? '', args: data.arguments ?? '' });
        break;
      }
      case 'tool/result': {
        const data = ev.data as { error?: { name?: string }; message?: { name?: string } };
        const ok = !data.error;
        const name = ok ? (data.message?.name ?? '') : (data.error?.name ?? '');
        this.emit(sid, { kind: 'tool-result', name, ok });
        break;
      }
      default:
        break;
    }
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

  /** 向指定 dsh 会话发一条消息（不等待结果，事件走 on()）。 */
  async sendMessage(dshSessionId: string, text: string): Promise<void> {
    await this.request('session/prompt', {
      sessionId: dshSessionId,
      contentBlocks: [{ type: 'text', text }],
    });
  }

  /** 中断/取消 dsh 会话当前回合（wire: session/cancel）。 */
  async cancel(dshSessionId: string): Promise<void> {
    await this.request('session/cancel', { sessionId: dshSessionId });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.pending.clear();
    this.listeners.clear();
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
      /* 已关闭 */
    }
    child.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
