// 浏览器版 window.paper 桥：把应用 IPC 契约映射到 HTTP RPC + SSE（Web(Host) 服务端）。
//
// 页面与 store 只依赖 window.paper 这一份契约，因此渲染层无需感知传输实现。
//
// 契约对齐：
//   invoke(channel, req)  → POST /rpc/<channel>             （返回 { ok, result }）
//   onAgentEvent/onSummaryEvent/onSearchEvent/onPapersEvent → GET /events（SSE，按事件名分发）
//   getPathForFile(file)  → 浏览器拿不到本地绝对路径，改为 uploadFile() 上传后取服务端路径
import type { PapersEvent } from '../shared/types';

const BIN_KEY = '__paperstudioBin';

interface PaperBridge {
  call: (channel: string, req?: unknown) => Promise<unknown>;
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  getPathForFile: (file: File) => string;
  uploadFile: (file: File) => Promise<string>;
  onAgentEvent: (listener: (payload: unknown) => void) => () => void;
  onSummaryEvent: (listener: (payload: unknown) => void) => () => void;
  onSearchEvent: (listener: (payload: unknown) => void) => () => void;
  onPapersEvent: (listener: (payload: PapersEvent) => void) => () => void;
}

/** RPC 响应体：网关异常时可能不是 JSON（如 502 的 "Bad Gateway "）。 */
interface RpcResponse {
  ok?: boolean;
  result?: unknown;
  message?: string;
  status?: string;
  path?: string | null;
}

/**
 * 读取 JSON 响应。网关/代理超时返回的是纯文本（如 502 "Bad Gateway "），
 * 直接 res.json() 会抛 `Unexpected token 'B', "Bad Gateway " is not valid JSON`，
 * 这里统一转成可读错误，避免把网关故障伪装成前端解析异常。
 */
async function readJson(res: Response, what: string): Promise<RpcResponse> {
  const text = await res.text();
  try {
    return JSON.parse(text) as RpcResponse;
  } catch {
    const brief = text.trim().slice(0, 120) || res.statusText || '未知错误';
    if (res.status === 502 || res.status === 504) {
      throw new Error(`${what}失败：网关超时或后端不可达（HTTP ${res.status} ${brief}）`);
    }
    throw new Error(`${what}失败：服务返回了非 JSON 响应（HTTP ${res.status} ${brief}）`);
  }
}

function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BIN_KEY]: btoa(String.fromCharCode(...value)) };
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeBinary(v);
    return out;
  }
  return value;
}

function decodeBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const b64 = obj[BIN_KEY];
    if (typeof b64 === 'string' && Object.keys(obj).length === 1) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeBinary(v);
    return out;
  }
  return value;
}

/** 上传浏览器选择的本地文件到服务端，返回服务端绝对路径（供 papers:importLocalPdf 等使用）。 */
export async function uploadFile(file: File): Promise<string> {
  const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  const body = await readJson(res, '上传');
  const result = body.result as { path?: string } | undefined;
  if (!body.ok || !result?.path) throw new Error(body.message ?? '上传失败');
  return result.path;
}

export function installWebBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { paper?: PaperBridge };
  if (w.paper) return; // 已注入（重复调用时避免覆盖）

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const streamHandlers = new Map<string, (ev: MessageEvent) => void>();
  let source: EventSource | null = null;

  /** 按事件名惰性订阅 SSE（EventSource 可自动重连）。 */
  const ensureStream = (type: string): void => {
    if (!source) source = new EventSource('/events');
    if (streamHandlers.has(type)) return;
    const handler = (ev: MessageEvent): void => {
      const set = listeners.get(type);
      if (!set) return;
      let payload: unknown;
      try {
        payload = decodeBinary(JSON.parse(ev.data));
      } catch {
        return;
      }
      for (const fn of [...set]) fn(payload);
    };
    streamHandlers.set(type, handler);
    source.addEventListener(type, handler as EventListener);
  };

  const subscribe = (type: string) => (listener: (payload: unknown) => void): (() => void) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener);
    ensureStream(type);
    return () => {
      set?.delete(listener);
    };
  };

  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => {
    const res = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload === undefined ? null : encodeBinary(payload)),
    });
    const body = await readJson(res, `RPC ${channel}`);
    if (!body.ok) throw new Error(body.message ?? `RPC 失败：${channel}`);
    return decodeBinary(body.result);
  };

  w.paper = {
    call: invoke,
    invoke,
    getPathForFile: () => '',
    uploadFile,
    onAgentEvent: subscribe('agent:event'),
    onSummaryEvent: subscribe('summary:event'),
    onSearchEvent: subscribe('search:event'),
    onPapersEvent: subscribe('papers:event') as PaperBridge['onPapersEvent'],
  };
}
