// EchoCap 能力网关客户端（Electron 主进程专用）。
//
// 背景：本应用的 dsh（deepseek-harness）后端已整体替换为 Echo 平台能力网关
// ECHO_CAP。原先「spawn dsh 子进程 + stdio 行分帧 JSON-RPC」的链路，改为通过平台
// 注入的 Unix Socket 调用 sub_agent.* / model.call.*。
//
// 传输：POST http://<http_host><base_path>/rpc/<method>，走 Unix Socket（--unix-socket 等价）；
//      响应信封 { ok, request_id, result }，失败时 ok=false 且带 error{code,message}。
// 鉴权：Authorization: Bearer <ECHO_CAP_AUTH_KEY>（key 由平台按 session 签发）。
//
// 安全边界：auth key 只在本模块内从环境变量 / capabilities.properties 读取并用于主进程
// 出站请求；不写盘、不进日志、不通过 IPC 下发渲染进程，也不进入构建产物。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface EchoCapEndpoint {
  socketPath: string;
  authKey: string;
  httpHost: string;
  basePath: string;
  envId: string;
}

export class EchoCapError extends Error {
  readonly code: string;

  constructor(message: string, code = 'ECHO_CAP_ERROR') {
    super(message);
    this.name = 'EchoCapError';
    this.code = code;
  }
}

const DEFAULT_HOST = 'echo-cap.invalid';
const DEFAULT_BASE = '/v1/capabilities';
const ENDPOINT_CACHE_MS = 3000;

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function propertiesPath(): string {
  const fromEnv = process.env.ECHO_CAP_PROPERTIES_FILE;
  if (fromEnv) return expandHome(fromEnv);
  return path.join(os.homedir(), '.echo', 'sys', 'capabilities.properties');
}

/** 解析 capabilities.properties（key=value 行）。不可读时返回空对象（平台未注入）。 */
function readProperties(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(propertiesPath(), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  } catch {
    /* 无 properties 文件 */
  }
  return out;
}

let cached: EchoCapEndpoint | null = null;
let cachedAt = 0;

/** 解析当前可用的 EchoCap 端点：环境变量优先，其次 capabilities.properties。 */
export function resolveEndpoint(force = false): EchoCapEndpoint {
  const now = Date.now();
  if (!force && cached && now - cachedAt < ENDPOINT_CACHE_MS) return cached;
  const props = readProperties();
  const keyEnv = props.auth_key_env || 'ECHO_CAP_AUTH_KEY';
  cached = {
    socketPath: expandHome(
      process.env.ECHO_CAP_SOCKET || props.socket_path || props.socket_display_path || '',
    ),
    authKey: process.env[keyEnv] || props.auth_key || '',
    httpHost: props.http_host || DEFAULT_HOST,
    basePath: props.base_path || DEFAULT_BASE,
    envId: process.env.ECHO_SSH_ENV_ID || '',
  };
  cachedAt = now;
  return cached;
}

/** EchoCap 是否可用（socket 存在且为套接字 + 有鉴权 key）。启动与健康检查共用。 */
export function echoCapStatus(): { ok: boolean; message?: string } {
  const ep = resolveEndpoint(true);
  if (!ep.socketPath) {
    return { ok: false, message: '未找到 ECHO_CAP socket（ECHO_CAP_SOCKET 与 capabilities.properties 均缺失）' };
  }
  try {
    if (!fs.statSync(ep.socketPath).isSocket()) {
      return { ok: false, message: `ECHO_CAP socket 不是套接字：${ep.socketPath}` };
    }
  } catch {
    return { ok: false, message: `ECHO_CAP socket 不存在：${ep.socketPath}` };
  }
  if (!ep.authKey) return { ok: false, message: '未找到 ECHO_CAP 鉴权 key' };
  return { ok: true };
}

export interface CapRpcOptions {
  /** 单次 HTTP 往返超时（ms）。 */
  timeoutMs?: number;
}

/**
 * 调用一个 ECHO_CAP 能力方法，校验 { ok, request_id, result } 信封并返回 result。
 * envelope 校验只此一处，业务代码只消费 result。
 */
export function capRpc<T = unknown>(method: string, params: object, opts: CapRpcOptions = {}): Promise<T> {
  const ep = resolveEndpoint();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const body = JSON.stringify({
    request_id: `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    params,
  });
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: ep.socketPath,
        path: `${ep.basePath}/rpc/${method}`,
        method: 'POST',
        headers: {
          Host: ep.httpHost,
          Authorization: `Bearer ${ep.authKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let env: { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
          try {
            env = JSON.parse(raw) as typeof env;
          } catch {
            reject(
              new EchoCapError(
                `ECHO_CAP 响应不是 JSON（HTTP ${res.statusCode}，${method}）：${raw.slice(0, 200)}`,
                'ECHO_CAP_BAD_RESPONSE',
              ),
            );
            return;
          }
          if (!env.ok) {
            reject(
              new EchoCapError(env.error?.message || `ECHO_CAP 调用失败：${method}`, env.error?.code || 'ECHO_CAP_FAILED'),
            );
            return;
          }
          resolve(env.result as T);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new EchoCapError(`ECHO_CAP 调用超时（${method}，${timeoutMs}ms）`, 'ECHO_CAP_TIMEOUT'));
    });
    req.on('error', (err: Error) => {
      reject(
        err instanceof EchoCapError
          ? err
          : new EchoCapError(`ECHO_CAP 连接失败（${method}）：${err.message}`, 'ECHO_CAP_UNREACHABLE'),
      );
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- sub_agent.*

export interface SubAgentTurn {
  turn_request_id: string;
  context_path: string;
  seq: number;
  status: string;
  done: boolean;
}

export interface SubAgentSection {
  sub_seq: number;
  type: 'content' | 'reasoning' | 'tool';
  completed: boolean;
  reasoning: string | null;
  content: string | null;
  toolname: string | null;
  tool_execution_state: unknown;
  has_summary: boolean;
  summary: string | null;
}

export interface SubAgentMessage {
  seq: number;
  created_at: string;
  status: string;
  stop_reason: string | null;
  error: { message?: string } | null;
  usermsg: string | null;
  sections: SubAgentSection[];
}

/**
 * 向指定 sub-agent 会话投递一条用户消息。waitMs=0 时不等待回合结束（立即拿到 seq），
 * 之后用 subAgentQuery 轮询该 seq 的 sections。
 */
export function subAgentSend(contextPath: string, text: string, waitMs = 0): Promise<SubAgentTurn> {
  return capRpc<SubAgentTurn>(
    'sub_agent.send',
    { context_path: contextPath, input: { text }, wait_ms: waitMs },
    { timeoutMs: waitMs > 0 ? waitMs + 30_000 : 60_000 },
  );
}

/** 读取 sub-agent 会话的轮次消息（含 sections 增量）。 */
export function subAgentQuery(
  contextPath: string,
  seq?: number,
  opts: { sectionTypes?: string[]; messageLimit?: number; sectionLimit?: number } = {},
): Promise<{ messages: SubAgentMessage[] }> {
  return capRpc<{ messages: SubAgentMessage[] }>(
    'sub_agent.query',
    {
      context_path: contextPath,
      ...(seq ? { seq } : {}),
      section_types: opts.sectionTypes ?? ['content', 'reasoning', 'tool'],
      message_limit: opts.messageLimit ?? 20,
      section_limit: opts.sectionLimit ?? 200,
      summary_stop: false,
      include_running: true,
    },
    { timeoutMs: 60_000 },
  );
}

// ---------------------------------------------------------------- model.call.*

export interface ModelCallOptions {
  /** 系统级指令（原 OpenAI messages 里的 system 段）。 */
  instructions?: string;
  modelProfile?: 'primary' | 'fast';
  /** 进度回调：平台只回报已生成字符数，不回报增量正文。 */
  onProgress?: (chars: number) => void;
  /** 整体超时（ms）。 */
  timeoutMs?: number;
}

export interface ModelCallResult {
  text: string;
  reasoning: string;
  profile: string;
}

interface AwaitResult {
  output?: { text?: string; reasoning?: string };
  meta?: { status?: string; model_profile_resolved?: string; progress_chars?: { total?: number } };
  status?: string;
  done?: boolean;
  error?: { code?: string; message?: string };
}

/**
 * 调用平台模型：model.call(async) + 轮询 model.call.await 直到 done。
 * 平台契约只在 status=success 时返回正文，因此本函数在完成后一次性返回全文
 * （onProgress 仍可拿到字符数进度）。
 */
export async function modelCall(text: string, opts: ModelCallOptions = {}): Promise<ModelCallResult> {
  const started = await capRpc<{ output?: { model_call_request_id?: string } }>(
    'model.call',
    {
      input: { text },
      async: true,
      model_profile: opts.modelProfile ?? 'primary',
      context_mode: 'isolated',
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    },
    { timeoutMs: 60_000 },
  );
  const rid = started?.output?.model_call_request_id;
  if (!rid) throw new EchoCapError('model.call 未返回 model_call_request_id', 'ECHO_CAP_BAD_RESPONSE');

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  for (;;) {
    const r = await capRpc<AwaitResult>(
      'model.call.await',
      { model_call_request_id: rid, timeout_ms: 30_000 },
      { timeoutMs: 60_000 },
    );
    const status = r.status ?? r.meta?.status ?? 'running';
    if (status === 'success' || (r.done && status !== 'error')) {
      return {
        text: r.output?.text ?? '',
        reasoning: r.output?.reasoning ?? '',
        profile: r.meta?.model_profile_resolved ?? 'primary',
      };
    }
    if (status === 'error') {
      throw new EchoCapError(r.error?.message || '模型调用失败', r.error?.code || 'MODEL_CALL_FAILED');
    }
    opts.onProgress?.(r.meta?.progress_chars?.total ?? 0);
    if (Date.now() > deadline) throw new EchoCapError('模型调用超时', 'ECHO_CAP_TIMEOUT');
  }
}
