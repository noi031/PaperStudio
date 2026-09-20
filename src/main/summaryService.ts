// P3 总结服务：双后端流式总结（dsh: OpenAI 兼容端点真流式；echocap: 平台 model.call，
// 完成后一次性回调全文）。
// 增量经 emit('summary:event') 推送（Web(Host) 版为 SSE 广播），
// 完成后写入 summaries 表，并生成 Markdown 文件到工作目录（storage/markdown），UI 只展示 MD 链接。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chatTextStream } from './llm.js';
import { echoCapStatus } from './echoCap.js';
import { resolveBackend } from './backend.js';
import type { PaperSettings, SummaryEvent, SummaryKind } from '../shared/types.js';
import type { HostEmit } from './ipc.js';

/** 全文总结输入截断上限（防超上下文）；可在设置页调整。 */
export const MAX_INPUT_CHARS = 120000;
/** 输出 token 上限；可在设置页调整。 */
export const MAX_OUTPUT_TOKENS = 8000;

/** 总结入库时记录的模型标识：echocap 为平台侧模型档位，dsh 为设置页模型名。 */
export function summaryModelLabel(s: PaperSettings): string {
  return resolveBackend(() => s) === 'echocap' ? 'echocap:primary' : s.llmModel;
}

export interface SummaryServiceOptions {
  getSettings: () => PaperSettings;
  /** 事件发射器（Web(Host) 版为 SSE 广播）。 */
  emit: HostEmit;
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
 *  图表相关指令完全在可编辑提示词中；figList 仅作为数据清单（论文图表路径）附加，不掺指令。 */
export function buildSummaryMessages(
  paperTitle: string,
  kind: SummaryKind,
  text: string,
  system?: string,
  maxInputChars: number = MAX_INPUT_CHARS,
  figList = '',
): Array<{ role: 'system' | 'user'; content: string }> {
  const sys = system?.trim() || (kind === 'selected' ? DEFAULT_SELECTED_PROMPT : DEFAULT_FULL_PROMPT);
  // 纯数据：论文图表清单（图片文件与总结同目录）。如何引用由可编辑提示词决定。
  const figNote = figList ? `\n\n论文图表清单（图片文件与总结文件同目录）：${figList}` : '';
  const clipped = text.length > maxInputChars ? `${text.slice(0, maxInputChars)}\n…（原文过长已截断）` : text;
  return [
    { role: 'system', content: sys + figNote },
    { role: 'user', content: `论文标题：${paperTitle}\n\n${clipped}` },
  ];
}

/** 内置默认提示词（与设置页 DEFAULT_SETTINGS 一致，留空恢复默认）。 */
const DEFAULT_SELECTED_PROMPT =
  '你是论文精读助手。用户选中了一段论文原文，请用中文解释这段内容：它在讲什么、在论文中起什么作用、有哪些关键概念。' +
  '输出 Markdown 格式：第一行 # 标题（概括这段内容），用 ## 小节、- 列表、**加粗** 组织，控制在 300-600 字。' +
  '如果系统提供的论文图表清单中包含与本段内容相关的图表，请用 Markdown 图片语法引用它（![第X页图](images/.../fig-X.png)），做到图文并茂；需要对比的数据用 Markdown 表格（如 | 指标 | 数值 |）呈现。' +
  '数学公式请用 LaTeX 记号书写并包裹：行内公式用 $...$（如 $E=mc^2$），独立成行的大公式用 $$...$$（如 $$\\mathcal{L} = -\\sum_i y_i \\log p_i$$）。';

const DEFAULT_FULL_PROMPT =
  '你是论文精读助手。请对整篇论文做结构化总结，按「背景 / 方法 / 结果 / 贡献与局限」四部分。' +
  '输出 Markdown 格式：# 标题（论文标题）、## 背景、## 方法、## 结果、## 贡献与局限，用 - 列表和 **加粗** 组织，800-1500 字。' +
  '请图文并茂：系统会提供论文图表清单（含图片引用路径），在总结中与图表相关的小节必须用 Markdown 图片语法引用论文原图（如 ![第3页图](images/.../fig-3.png)，路径按清单原样给出）；需要对比的数据用 Markdown 表格（如 | 指标 | 数值 |）呈现。' +
  '数学公式请用 LaTeX 记号书写并包裹：行内公式用 $...$（如 $E=mc^2$），独立成行的大公式用 $$...$$（如 $$\\mathcal{L} = -\\sum_i y_i \\log p_i$$）。';

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
    this.opts.emit('summary:event', payload);
  }

  /** 启动一次流式总结；立即返回 job id，增量走 summary:event。figList 为论文图表清单（可选）。
   *  前置检查按后端区分：echocap 校验平台网关可达；dsh 校验设置页已配 LLM API Key。 */
  run(paperId: string, kind: SummaryKind, text: string, paperTitle: string, figList = ''): { id: string } {
    const id = randomUUID();
    const settings = this.opts.getSettings();
    if (resolveBackend(() => settings) === 'echocap') {
      const cap = echoCapStatus();
      if (!cap.ok) {
        this.emit({ id, kind: 'error', message: `EchoCap 不可用：${cap.message}` });
        return { id };
      }
    } else if (!settings.llmApiKey) {
      this.emit({ id, kind: 'error', message: '未配置 LLM API Key，请到设置页填写' });
      return { id };
    }
    void this.stream(paperId, kind, text, paperTitle, id, figList);
    return { id };
  }

  /** 把总结内容写成 Markdown 文件（工作目录）；失败返回 null（不影响入库）。 */
  private writeMd(paperId: string, kind: SummaryKind, content: string, paperTitle: string): string | null {
    return writeSummaryMd(this.opts.markdownDir, paperId, kind, content, paperTitle);
  }

  /** 生成一份总结（按后端走 chatTextStream：dsh 真流式逐块 emit；echocap 完成后一次性 emit）。 */
  private async stream(
    paperId: string,
    kind: SummaryKind,
    text: string,
    paperTitle: string,
    id: string,
    figList = '',
  ): Promise<void> {
    try {
      const settings = this.opts.getSettings();
      const systemPrompt = kind === 'selected' ? settings.promptSummarySelected : settings.promptSummaryFull;
      const messages = buildSummaryMessages(
        paperTitle,
        kind,
        text,
        systemPrompt,
        settings.llmMaxInputChars,
        figList,
      );
      let content = '';
      await chatTextStream(settings, messages, (delta) => {
        content += delta;
        this.emit({ id, kind: 'delta', text: delta });
      });
      const mdPath = this.writeMd(paperId, kind, content, paperTitle);
      this.opts.insertSummary(paperId, kind, content, summaryModelLabel(settings), mdPath);
      this.emit({ id, kind: 'done' });
    } catch (err) {
      this.emit({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}
