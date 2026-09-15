// P7 演示服务：选论文 → 生成幻灯片提纲 → 导出 .pptx（pptxgenjs）。
import fs from 'node:fs';
import path from 'node:path';
import pptxgen from 'pptxgenjs';
import type { PaperSettings, PaperRecord, SlideItem } from '../shared/types.js';
import { chatJson } from './llm.js';

const SLIDES_SYSTEM =
  '你是演示文稿专家。根据论文信息生成 8-12 页幻灯片的提纲：第一页为标题页，最后一页为总结/展望。' +
  '每页包含 title（短标题）与 bullets（3-5 条要点，每条一行、一页内放得下），可选 note（演讲备注）。' +
  '输出 JSON 数组：[{"title":"...","bullets":["...","..."],"note":"..."}]。' +
  '数学公式一律用纯文本表达（如 γ、x²、B±→D），禁止使用任何 LaTeX 记号。';

/** 组装幻灯片提纲请求消息（纯函数，供单测）。system 为空时用内置默认。 */
export function buildSlidesMessages(
  paper: PaperRecord,
  system?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const abs = (paper.abstract ?? '').replace(/\s+/g, ' ').slice(0, 2000);
  return [
    { role: 'system', content: system?.trim() || SLIDES_SYSTEM },
    {
      role: 'user',
      content: `论文标题：${paper.title}\n作者：${paper.authors.join(', ') || '未知'}\n年份：${paper.year ?? '未知'}\n\n摘要：${abs || '（无）'}\n\n请生成幻灯片提纲。`,
    },
  ];
}

/** 调用 LLM 生成幻灯片提纲。 */
export async function generateSlides(settings: PaperSettings, paper: PaperRecord): Promise<SlideItem[]> {
  const data = await chatJson<Array<{ title?: unknown; bullets?: unknown; note?: unknown }>>(
    settings,
    buildSlidesMessages(paper, settings.promptSlides),
  );
  const slides = (Array.isArray(data) ? data : []).map((s) => ({
    title: String(s.title ?? '').trim(),
    bullets: Array.isArray(s.bullets) ? s.bullets.map((b) => String(b).trim()).filter(Boolean) : [],
    note: typeof s.note === 'string' && s.note ? s.note : undefined,
  }));
  const valid = slides.filter((s) => s.title);
  if (valid.length === 0) throw new Error('LLM 未返回有效幻灯片提纲');
  return valid;
}

/** 导出 .pptx（pptxgenjs），写入 dir；返回文件绝对路径。 */
export async function exportPptx(presentation: { title: string; slides: SlideItem[] }, dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const safe = presentation.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'presentation';
  const filePath = path.join(dir, `${safe}.pptx`);
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';
  pptx.author = 'PaperStudio';
  presentation.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(
      i === 0 ? presentation.title : s.title,
      {
        x: 0.6,
        y: i === 0 ? 2.4 : 0.4,
        w: 12.1,
        h: i === 0 ? 1.2 : 0.8,
        fontSize: i === 0 ? 36 : 28,
        bold: true,
        color: '1A237E',
        fontFace: 'Microsoft YaHei',
      },
    );
    if (i === 0 && s.note) {
      slide.addText(s.note, { x: 0.6, y: 3.8, w: 12.1, h: 0.8, fontSize: 16, color: '666666' });
    }
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, breakLine: true, paraSpaceAfter: 8 } })),
        {
          x: 0.8,
          y: i === 0 ? 3.2 : 1.4,
          w: 11.7,
          h: 5.6,
          fontSize: 16,
          color: '333333',
          fontFace: 'Microsoft YaHei',
        },
      );
    }
  });
  await pptx.writeFile({ fileName: filePath });
  return filePath;
}
