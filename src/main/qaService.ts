// 阅读器 AI 问答：基于论文全文/高亮文本回答用户问题。
// 与总结同构：run() 立即返回 job id，增量经 qa:event 推送；回答完成后写成 Markdown
// 文件（markdownDir/qa/），done 事件携带文件路径，渲染层只展示链接、点击弹窗查看。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PaperSettings, QaEvent } from '../shared/types.js';
import type { HostEmit } from './ipc.js';
import { chatTextStream } from './llm.js';
import { resolveBackend } from './backend.js';
import { echoCapStatus } from './echoCap.js';

export interface QaServiceOptions {
  getSettings: () => PaperSettings;
  emit: HostEmit;
  /** Markdown 工作目录（storage/markdown），问答 MD 写在 qa/ 子目录。 */
  markdownDir: string;
}

export class QaService {
  constructor(private readonly opts: QaServiceOptions) {}

  private emit(payload: QaEvent): void {
    this.opts.emit('qa:event', payload);
  }

  /** 启动一次基于论文全文的问答；立即返回 job id，增量走 qa:event。 */
  run(paperId: string, paperTitle: string, fullText: string, question: string): { id: string } {
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
    void this.ask(paperId, paperTitle, fullText, question, id);
    return { id };
  }

  private async ask(paperId: string, paperTitle: string, fullText: string, question: string, id: string): Promise<void> {
    try {
      const settings = this.opts.getSettings();
      const maxChars = settings.llmMaxInputChars || 120000;
      const text =
        fullText.length > maxChars ? `${fullText.slice(0, maxChars)}\n\n…（全文过长，已截断）` : fullText;
      const messages = [
        {
          role: 'system' as const,
          content:
            '你是论文阅读问答助手。用户会提供一篇论文的标题、相关文本（全文或高亮段落），以及针对这篇论文的问题。' +
            '请基于提供的内容回答，使用中文，回答使用 Markdown 格式（可用加粗、列表、小标题等使排版清晰）；' +
            '数学公式用 LaTeX 记号书写并包裹：行内公式用 $...$（如 $E=mc^2$），独立成行的大公式用 $$...$$。' +
            '若提供的内容中没有相关信息，请明确说明论文未涉及该内容，不要编造。' +
            '回答尽量具体，可引用论文中的方法、结论或数据。',
        },
        {
          role: 'user' as const,
          content: `论文标题：${paperTitle}\n\n相关文本：\n${text}\n\n问题：${question}`,
        },
      ];
      let content = '';
      await chatTextStream(settings, messages, (delta) => {
        content += delta;
        this.emit({ id, kind: 'delta', text: delta });
      });
      const mdPath = this.writeMd(paperId, paperTitle, question, content);
      this.emit({ id, kind: 'done', mdPath });
    } catch (err) {
      this.emit({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 把问答内容写成 Markdown 文件（markdownDir/qa/），返回绝对路径。 */
  private writeMd(paperId: string, paperTitle: string, question: string, content: string): string | null {
    try {
      const dir = path.join(this.opts.markdownDir, 'qa');
      fs.mkdirSync(dir, { recursive: true });
      const safe = (paperTitle || 'paper').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 24) || 'paper';
      const stamp = new Date()
        .toISOString()
        .replace(/[:T]/g, '-')
        .slice(0, 19)
        .replace(/-/g, '')
        .slice(0, 14);
      const file = path.join(dir, `${safe}-${paperId.slice(0, 8)}-${stamp}.md`);
      const md = `# 论文问答\n\n**论文**：${paperTitle}\n\n**问题**：${question}\n\n**时间**：${new Date().toLocaleString('zh-CN')}\n\n---\n\n${content}\n`;
      fs.writeFileSync(file, md, 'utf8');
      return file;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[qa] 写 Markdown 失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}