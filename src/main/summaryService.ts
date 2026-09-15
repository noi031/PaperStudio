// P3 总结服务：OpenAI 兼容端点流式总结。
// chunk 经 webContents.send('summary:event') 推送，完成后写入 summaries 表。
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import type { PaperSettings, SummaryEvent, SummaryKind } from '../shared/types.js';

/** 全文总结输入截断上限（防超上下文）。 */
export const MAX_INPUT_CHARS = 60000;

export interface SummaryServiceOptions {
  getSettings: () => PaperSettings;
  getWindow: () => BrowserWindow | null;
  insertSummary: (paperId: string, kind: SummaryKind, content: string, model: string | null) => void;
}

/** 组装 chat 消息（纯函数，供单测）。system 为空时使用内置默认提示词。 */
export function buildSummaryMessages(
  paperTitle: string,
  kind: SummaryKind,
  text: string,
  system?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const sys =
    system?.trim() ||
    (kind === 'selected'
      ? '你是论文精读助手。用户选中了一段论文原文，请用中文解释这段内容：它在讲什么、在论文中起什么作用、有哪些关键概念。保持简洁，分点输出。数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。'
      : '你是论文精读助手。请对整篇论文做结构化总结，按「背景 / 方法 / 结果 / 贡献与局限」四部分分点输出，语言为中文。数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。');
  const clipped = text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n…（原文过长已截断）` : text;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `论文标题：${paperTitle}\n\n${clipped}` },
  ];
}

export class SummaryService {
  constructor(private readonly opts: SummaryServiceOptions) {}

  private emit(payload: SummaryEvent): void {
    this.opts.getWindow()?.webContents.send('summary:event', payload);
  }

  /** 启动一次流式总结；立即返回 job id，chunk 走 summary:event。 */
  run(paperId: string, kind: SummaryKind, text: string, paperTitle: string): { id: string } {
    const id = randomUUID();
    const { llmBaseUrl, llmApiKey, llmModel } = this.opts.getSettings();
    if (!llmApiKey) {
      this.emit({ id, kind: 'error', message: '未配置 LLM API Key，请到设置页填写' });
      return { id };
    }
    void this.stream(paperId, kind, text, paperTitle, id, llmBaseUrl, llmApiKey, llmModel);
    return { id };
  }

  private async stream(
    paperId: string,
    kind: SummaryKind,
    text: string,
    paperTitle: string,
    id: string,
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<void> {
    try {
      const client = new OpenAI({ baseURL: baseUrl || undefined, apiKey });
      const settings = this.opts.getSettings();
      const systemPrompt = kind === 'selected' ? settings.promptSummarySelected : settings.promptSummaryFull;
      const stream = await client.chat.completions.create({
        model,
        messages: buildSummaryMessages(paperTitle, kind, text, systemPrompt),
        stream: true,
      });
      let content = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        content += delta;
        this.emit({ id, kind: 'delta', text: delta });
      }
      this.opts.insertSummary(paperId, kind, content, model);
      this.emit({ id, kind: 'done' });
    } catch (err) {
      this.emit({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}
