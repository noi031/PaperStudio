// 主进程 LLM 辅助：OpenAI 兼容端点，供方向建议/写作/演示等批量任务使用。
//
// 原实现：直连 settings.llmBaseUrl/llmApiKey 指向的 OpenAI 兼容端点。
// 现实现：统一经 Echo 平台能力网关 model.call（ECHO_CAP），应用不再需要用户自备
//        LLM 端点与 API Key；chatText/chatJson 的调用方签名保持不变。
import type { PaperSettings } from '../shared/types.js';
import { modelCall } from './echoCap.js';

/** 兼容保留：EchoCap 由平台鉴权，不再要求用户填写 API Key。 */
export function requireSettings(_s: PaperSettings): string {
  return 'echocap';
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** 输出 token 上限：由平台模型侧决定，此处仅保留导出以兼容既有引用。 */
export const MAX_OUTPUT_TOKENS = 8000;

export interface ChatCallOptions {
  /** 进度回调（平台只回报已生成字符数）。 */
  onProgress?: (chars: number) => void;
  /** 整体超时（ms）。 */
  timeoutMs?: number;
  modelProfile?: 'primary' | 'fast';
}

/** 把 chat messages 拆成平台 model.call 需要的 instructions(system) + text(user)。 */
export function splitMessages(messages: ChatMessage[]): { instructions: string; text: string } {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');
  const user = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');
  if (!user) return { instructions: '', text: sys };
  return { instructions: sys, text: user };
}

/** 非流式补全，返回完整文本。 */
export async function chatText(
  _s: PaperSettings,
  messages: ChatMessage[],
  opts: ChatCallOptions = {},
): Promise<string> {
  const { instructions, text } = splitMessages(messages);
  if (!text) throw new Error('LLM 输入为空');
  const res = await modelCall(text, {
    instructions,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    modelProfile: opts.modelProfile,
  });
  if (!res.text) throw new Error('LLM 返回为空');
  return res.text;
}

/**
 * 「流式」补全：平台 model.call 不返回增量正文，因此在完成后一次性回调全文。
 * 保留该入口是为了沿用既有「边生成边 emit 增量」的调用结构（总结服务）。
 */
export async function chatTextStream(
  s: PaperSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatCallOptions = {},
): Promise<string> {
  const text = await chatText(s, messages, opts);
  onDelta(text);
  return text;
}

/**
 * 非流式补全并要求 JSON 输出。从返回文本中稳健地抽取 JSON 对象/数组：
 * 优先解析 ```json ... ``` 代码块，其次去掉首尾噪声后直接 JSON.parse。
 */
export async function chatJson<T>(
  s: PaperSettings,
  messages: ChatMessage[],
  opts: ChatCallOptions = {},
): Promise<T> {
  const text = await chatText(
    s,
    [...messages, { role: 'system', content: '只输出 JSON，不要任何解释、markdown 代码块以外的内容或前后缀文字。' }],
    opts,
  );
  return extractJson<T>(text);
}

/**
 * 修复 JSON 字符串中的反斜杠转义（仅用于整体 JSON.parse 失败后的兜底）。
 * LLM 在 JSON 里写 LaTeX 时通常把 \gamma、\textbf 等原样输出：\g 非法转义（\t \b \n \f \r
 * 虽"合法"但会被误解析成控制符）。LaTeX 字面量优先：已双写的 \\ 保留，其余 \X 一律双写为
 * \\X，使 parse 后得到原样的 \X 字面量。
 */
export function repairJsonEscapes(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = s[i + 1];
    if (next === '\\') {
      out += '\\\\'; // 已双写（合法 \\ 对）：保留
      i += 2;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      out += '\\' + s.slice(i + 1, i + 6); // 合法 \uXXXX（如 \u4e2d）：保留
      i += 6;
    } else {
      out += '\\\\' + (next ?? ''); // \g、\t(extbf)、\b(egin) 等一律按 LaTeX 字面量双写
      i += 2;
    }
  }
  return out;
}

export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const parse = (s: string): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      const repaired = repairJsonEscapes(s);
      if (repaired !== s) return JSON.parse(repaired) as T;
      throw new Error();
    }
  };
  try {
    return parse(candidate);
  } catch {
    // 退而求其次：取第一个 { 或 [ 到最后一个 } 或 ] 之间的内容
    const start = Math.min(
      ...['{', '['].map((c) => {
        const i = candidate.indexOf(c);
        return i === -1 ? Infinity : i;
      }),
    );
    const end = Math.max(
      ...['}', ']'].map((c) => {
        const i = candidate.lastIndexOf(c);
        return i === -1 ? -1 : i;
      }),
    );
    if (start === Infinity || end < start) throw new Error(`无法解析 LLM JSON 输出：${trimmed.slice(0, 200)}`);
    return parse(candidate.slice(start, end + 1)) as T;
  }
}
