// P3 总结服务：OpenAI 兼容端点流式总结。
// chunk 经 webContents.send('summary:event') 推送，完成后写入 summaries 表，
// 并生成 Markdown 文件到工作目录（storage/markdown），UI 只展示 MD 链接。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import type { PaperSettings, SummaryEvent, SummaryKind } from '../shared/types.js';

/** 全文总结输入截断上限（防超上下文）；可在设置页调整。 */
export const MAX_INPUT_CHARS = 120000;
/** 输出 token 上限；可在设置页调整。 */
export const MAX_OUTPUT_TOKENS = 8000;

export interface SummaryServiceOptions {
  getSettings: () => PaperSettings;
  getWindow: () => BrowserWindow | null;
  /** 写入 Markdown 文件的工作目录（storage/markdown）。 */
  markdownDir: string;
  insertSummary: (
    paperId: string,
    kind: SummaryKind,
    content: string,
    model: string | null,
    mdPath: string | null,
  ) => void;
}

/** 组装 chat 消息（纯函数，供单测）。system 为空时使用内置默认提示词。
 *  figList：论文图表清单（如「第3页图：images/xxx/fig-3.png」），非空时追加到 system，
 *  引导模型图文并茂（Markdown 图片引用 + 表格）。 */
export function buildSummaryMessages(
  paperTitle: string,
  kind: SummaryKind,
  text: string,
  system?: string,
  maxInputChars: number = MAX_INPUT_CHARS,
  figList = '',
): Array<{ role: 'system' | 'user'; content: string }> {
  const sys =
    system?.trim() ||
    (kind === 'selected'
      ? '你是论文精读助手。用户选中了一段论文原文，请用中文解释这段内容：它在讲什么、在论文中起什么作用、有哪些关键概念。' +
        '输出 Markdown 格式：第一行 # 标题（概括这段内容），用 ## 小节、- 列表、**加粗** 组织，控制在 300-600 字。' +
        '数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。'
      : '你是论文精读助手。请对整篇论文做结构化总结，按「背景 / 方法 / 结果 / 贡献与局限」四部分。' +
        '输出 Markdown 格式：# 标题（论文标题）、## 背景、## 方法、## 结果、## 贡献与局限，用 - 列表和 **加粗** 组织，800-1500 字。' +
        '数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。');
  const figNote = figList
    ? '\n\n论文图表截图（已保存到工作目录，与总结文件同目录）：' +
      figList +
      '。' +
      '请图文并茂：在总结中与图表相关的小节用 Markdown 图片语法引用（如 ![第3页图](images/xxx/fig-3.png)，路径必须与上面给出的完全一致）；' +
      '需要对比数据时用 Markdown 表格（如 | 指标 | 数值 |）。'
    : '';
  const clipped = text.length > maxInputChars ? `${text.slice(0, maxInputChars)}\n…（原文过长已截断）` : text;
  return [
    { role: 'system', content: sys + figNote },
    { role: 'user', content: `论文标题：${paperTitle}\n\n${clipped}` },
  ];
}

/** 把总结内容写成 Markdown 文件（工作目录）；失败返回 null。供总结服务和论文包导入复用。 */
export function writeSummaryMd(
  markdownDir: string,
  paperId: string,
  kind: SummaryKind,
  content: string,
  paperTitle: string,
): string | null {
  try {
    const dir = markdownDir;
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const safeTitle = paperTitle.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'summary';
    const file = path.join(dir, `${safeTitle}-${kind}-${ts}.md`);
    fs.writeFileSync(file, `# ${paperTitle}\n\n> 生成时间：${new Date().toLocaleString('zh-CN')} · 类型：${kind === 'full' ? '全文总结' : '选中段落总结'}\n\n${content}\n`, 'utf8');
    return file;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[summary] 写 MD 文件失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export class SummaryService {
  constructor(private readonly opts: SummaryServiceOptions) {}

  private emit(payload: SummaryEvent): void {
    this.opts.getWindow()?.webContents.send('summary:event', payload);
  }

  /** 启动一次流式总结；立即返回 job id，chunk 走 summary:event。figList 为论文图表清单（可选）。 */
  run(paperId: string, kind: SummaryKind, text: string, paperTitle: string, figList = ''): { id: string } {
    const id = randomUUID();
    const { llmBaseUrl, llmApiKey, llmModel } = this.opts.getSettings();
    if (!llmApiKey) {
      this.emit({ id, kind: 'error', message: '未配置 LLM API Key，请到设置页填写' });
      return { id };
    }
    void this.stream(paperId, kind, text, paperTitle, id, llmBaseUrl, llmApiKey, llmModel, figList);
    return { id };
  }

  /** 把总结内容写成 Markdown 文件（工作目录）；失败返回 null（不影响入库）。 */
  private writeMd(paperId: string, kind: SummaryKind, content: string, paperTitle: string): string | null {
    return writeSummaryMd(this.opts.markdownDir, paperId, kind, content, paperTitle);
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
    figList = '',
  ): Promise<void> {
    try {
      const client = new OpenAI({ baseURL: baseUrl || undefined, apiKey });
      const settings = this.opts.getSettings();
      const systemPrompt = kind === 'selected' ? settings.promptSummarySelected : settings.promptSummaryFull;
      const stream = await client.chat.completions.create({
        model,
        messages: buildSummaryMessages(paperTitle, kind, text, systemPrompt, settings.llmMaxInputChars, figList),
        max_tokens: settings.llmMaxOutputTokens || MAX_OUTPUT_TOKENS,
        stream: true,
      });
      let content = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        content += delta;
        this.emit({ id, kind: 'delta', text: delta });
      }
      const mdPath = this.writeMd(paperId, kind, content, paperTitle);
      this.opts.insertSummary(paperId, kind, content, model, mdPath);
      this.emit({ id, kind: 'done' });
    } catch (err) {
      this.emit({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}
