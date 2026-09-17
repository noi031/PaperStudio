// 代理宿主抽象：dsh 引擎（dshAgentHost.ts）与 EchoCap 平台网关（echocapAgentHost.ts）
// 的共同接口。上层（agentService / ipc / 渲染层）只依赖这里的 AgentEvent 形状与
// AgentHost 接口，具体实现由 createAgentHost 按后端解析结果（backend.ts）选择：
//
//   - dsh 后端：spawn deepseek-harness 子进程 + stdio 行分帧 JSON-RPC，
//     注入论文域 MCP server（mcpEntry），LLM 凭证来自设置页。
//   - echocap 后端：经平台能力网关 Unix Socket 调用 sub_agent.send / sub_agent.query，
//     轮询轮次 sections 归一化为同一组 AgentEvent；模型与鉴权由平台提供。
//
// 两种实现的语义差异与取舍见各实现文件头注释；对上层保持一致：
// AgentEvent 形状与 ready / start / on / sendMessage / cancel / close 语义不变。
import type { PaperSettings } from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { resolveBackend } from './backend.js';
import { DshAgentHost } from './dshAgentHost.js';
import { EchoCapAgentHost } from './echocapAgentHost.js';

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

export interface AgentHost {
  /** 后端是否已就绪（dsh：子进程活 + initialize 成功；echocap：已 start 且网关可达）。 */
  readonly ready: boolean;
  /** 启动/连接后端，返回引擎版本串。失败抛错，可重试。 */
  start(mcpEntry?: string): Promise<string>;
  /** 订阅指定会话的事件流；返回注销函数。 */
  on(sessionId: string, listener: (e: AgentEvent) => void): () => void;
  /** 向指定会话发一条消息（不等待回合结束，事件走 on()）。 */
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** 打断会话当前回合（echocap 下为本地停止轮询）。 */
  cancel(sessionId: string): Promise<void>;
  /** 关闭后端（应用退出时）。 */
  close(): Promise<void>;
}

export interface AgentHostOptions {
  /** 应用根（dsh 工作区 cwd + 定位 node_modules 里的 bin.js；echocap 下不使用）。 */
  appRoot?: string;
  /** userData 目录（写 dsh-mcp.patch.yml；echocap 下不使用）。 */
  userDataDir?: string;
  /** 启动时读取的 settings（dsh 取 llmApiKey/llmModel/llmBaseUrl）。 */
  settings?: () => PaperSettings;
  /** dsh stderr 行回调（调试/MCP 排查用；不传则丢弃）。 */
  onStderrLine?: (line: string) => void;
  /** 原始 stdout 行回调（调试用）。 */
  onRawLine?: (line: string) => void;
  /** 宿主日志回调（调试用）。 */
  onLog?: (line: string) => void;
  /** echocap 轮次轮询间隔（ms）。 */
  pollMs?: number;
}

/** 按后端解析结果创建对应实现（进程启动时调用一次）。 */
export function createAgentHost(opts: AgentHostOptions): AgentHost {
  const getSettings = opts.settings ?? (() => DEFAULT_SETTINGS);
  return resolveBackend(getSettings) === 'echocap' ? new EchoCapAgentHost(opts) : new DshAgentHost(opts);
}
