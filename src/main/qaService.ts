// 阅读器 AI 问答：基于论文全文回答用户问题。
// 与总结同构：run() 立即返回 job id，回答增量经 qa:event 推送（dsh 真流式 / echocap 一次性）。
import { randomUUID } from 'node:crypto';
import type { PaperSettings, QaEvent } from '../shared/types.js';
import type { HostEmit } from './ipc.js';
import { chatTextStream } from './llm.js';
import { resolveBackend } from './backend.js';
import { echoCapStatus } from './echoCap.js';

export interface QaServiceOptions {
  getSettings: () => PaperSettings;
  emit: HostEmit;
}

export class QaService {
  constructor(private readonly opts: QaServiceOptions) {}

  private emit(payload: QaEvent): void {
    this.opts.emit('qa:event', payload);
  }

  /** 启动一次基于论文全文的问答；立即返回 job id，增量走 qa:event。 */
  run(paperTitle: string, fullText: string, question: string): { id: string } {
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
    void this.ask(paperTitle, fullText, question, id);
    return { id };
  }

  private async ask(paperTitle: string, fullText: string, question: string, id: string): Promise<void> {
    try {
      const settings = this.opts.getSettings();
      const maxChars = settings.llmMaxInputChars || 120000;
      const text =
        fullText.length > maxChars ? `${fullText.slice(0, maxChars)}\n\n…（全文过长，已截断）` : fullText;
      const messages = [
        {
          role: 'system' as const,
          content:
            '你是论文阅读问答助手。用户会提供一篇论文的标题、全文，以及针对这篇论文的问题。' +
            '请基于论文内容回答，使用中文；若论文中没有相关信息，请明确说明论文未涉及该内容，不要编造。' +
            '回答尽量具体，可引用论文中的方法、结论或数据。',
        },
        {
          role: 'user' as const,
          content: `论文标题：${paperTitle}\n\n论文全文：\n${text}\n\n问题：${question}`,
        },
      ];
      await chatTextStream(settings, messages, (delta) => this.emit({ id, kind: 'delta', text: delta }));
      this.emit({ id, kind: 'done' });
    } catch (err) {
      this.emit({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}
