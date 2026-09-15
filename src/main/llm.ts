// 主进程 LLM 直连辅助：OpenAI 兼容端点，供方向建议/写作/演示等批量任务使用。
// 与 SummaryService 同源（settings.llmBaseUrl/llmApiKey/llmModel），不经过 dsh。
import OpenAI from 'openai';
import type { PaperSettings } from '../shared/types.js';

export function requireSettings(s: PaperSettings): string {
  if (!s.llmApiKey) throw new Error('未配置 LLM API Key，请到设置页填写');
  return s.llmApiKey;
}

export function createClient(s: PaperSettings): OpenAI {
  return new OpenAI({ baseURL: s.llmBaseUrl || undefined, apiKey: s.llmApiKey });
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** 输出 token 上限：不传时多数服务默认 4096，长文（总结/写作/方向建议）会被截断。 */
export const MAX_OUTPUT_TOKENS = 8000;

/** 非流式补全，返回完整文本。 */
export async function chatText(s: PaperSettings, messages: ChatMessage[]): Promise<string> {
  requireSettings(s);
  const client = createClient(s);
  const res = await client.chat.completions.create({
    model: s.llmModel,
    messages,
    max_tokens: s.llmMaxOutputTokens || MAX_OUTPUT_TOKENS,
  });
  const text = res.choices[0]?.message?.content ?? '';
  if (!text) throw new Error('LLM 返回为空');
  return text;
}

/**
 * 非流式补全并要求 JSON 输出。从返回文本中稳健地抽取 JSON 对象/数组：
 * 优先解析 ```json ... ``` 代码块，其次去掉首尾噪声后直接 JSON.parse。
 */
export async function chatJson<T>(s: PaperSettings, messages: ChatMessage[]): Promise<T> {
  const text = await chatText(s, [
    ...messages,
    { role: 'system', content: '只输出 JSON，不要任何解释、markdown 代码块以外的内容或前后缀文字。' },
  ]);
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
