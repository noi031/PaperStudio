// P6 写作服务：参考多篇论文 → 生成大纲 → 逐节撰写 LaTeX 草稿 → 导出 docx / md / tex / bib。
// 直连 LLM（非流式）：大纲为 JSON，单节正文为 LaTeX 源码（数学公式用 LaTeX 记号，可用 \cite{} 引用）。
import fs from 'node:fs';
import path from 'node:path';
import type { PaperSettings, PaperRecord, DraftOutlineItem, DraftSection } from '../shared/types.js';
import { chatJson, chatText } from './llm.js';

const OUTLINE_SYSTEM =
  '你是学术写作助手。用户会给出 1-N 篇参考论文（标题/作者/年份/摘要），请参考它们的结构与写作风格，' +
  '为新论文生成 8-12 节大纲。每个小节给出 heading 与 description（该节要写什么、包含哪些小节）。' +
  '输出 JSON 数组：[{"heading":"...","description":"..."}]。' +
  'heading 用论文语言（中文或英文均可，保留必要术语），description 中数学公式可用 LaTeX 记号描述（如 $\\gamma$、$B^\\pm \\to D(K^0_S h^{\\prime +} h^{\\prime -}) h^\\pm$）。';

const SECTION_SYSTEM =
  '你是学术写作助手。根据参考论文信息与大纲，为指定小节撰写 LaTeX 论文初稿：逻辑清晰、内容扎实，500-1200 字。' +
  '必须用 LaTeX 源码输出：数学公式一律用标准 LaTeX 记号（如 $\\gamma$、$E = mc^2$、$\\frac{a}{b}$、$B^\\pm \\to D^0 K^\\pm$），' +
  '需要引用参考论文时用 \\cite{key}（key 格式为 ref1、ref2…，对应参考论文序号），列表用 itemize/enumerate，强调用 \\textbf{}。' +
  '只输出小节正文源码（不要 \\section{}、\\begin{document} 等外壳），第一行不要重复小节标题。';

export interface OutlineOptions {
  /** 主论文（可能为 null：无关联论文时只依据参考论文） */
  paper: PaperRecord | null;
  /** 参考论文列表（可为空） */
  references: PaperRecord[];
}

/** 组装参考论文上下文文本（纯函数，供单测）。 */
export function buildReferencesText(references: PaperRecord[], maxAbs = 600): string {
  const lines = references.map((p, i) => {
    const abs = (p.abstract ?? '').replace(/\s+/g, ' ').slice(0, maxAbs);
    return (
      `[ref${i + 1}] ${p.title}（${p.year ?? '年份未知'}${p.venue ? `, ${p.venue}` : ''}` +
      `${p.authors.length ? `, 作者: ${p.authors.join(', ')}` : ''}）\n   摘要：${abs || '（无）'}`
    );
  });
  return lines.join('\n\n');
}

/** 组装大纲请求消息（纯函数，供单测）。 */
export function buildOutlineMessages(opts: OutlineOptions): Array<{ role: 'system' | 'user'; content: string }> {
  const refs = opts.paper ? [opts.paper, ...opts.references.filter((r) => r.id !== opts.paper!.id)] : opts.references;
  const refText = refs.length > 0 ? buildReferencesText(refs) : '（无参考论文，请按通用学术论文结构生成大纲）';
  const target = opts.paper ? `要写的新论文主题：${opts.paper.title}\n` : '要写的新论文主题：（未指定，请生成通用学术论文大纲）';
  return [
    { role: 'system', content: OUTLINE_SYSTEM },
    { role: 'user', content: `${target}\n\n参考论文：\n${refText}\n\n请生成大纲。` },
  ];
}

/** 组装单节撰写请求消息（纯函数，供单测）。 */
export function buildSectionMessages(
  opts: OutlineOptions,
  outline: DraftOutlineItem[],
  item: DraftOutlineItem,
): Array<{ role: 'system' | 'user'; content: string }> {
  const refs = opts.paper ? [opts.paper, ...opts.references.filter((r) => r.id !== opts.paper!.id)] : opts.references;
  const refText = refs.length > 0 ? buildReferencesText(refs, 400) : '（无参考论文）';
  const outlineText = outline.map((o, i) => `${i + 1}. ${o.heading}${o.description ? `：${o.description}` : ''}`).join('\n');
  const target = opts.paper ? `要写的新论文主题：${opts.paper.title}` : '要写的新论文主题：（未指定）';
  return [
    { role: 'system', content: SECTION_SYSTEM },
    {
      role: 'user',
      content: `${target}\n\n参考论文：\n${refText}\n\n大纲：\n${outlineText}\n\n请用 LaTeX 源码撰写第 ${outline.indexOf(item) + 1} 节「${item.heading}」的正文。`,
    },
  ];
}

/** 调用 LLM 生成大纲。 */
export async function generateOutline(
  settings: PaperSettings,
  opts: OutlineOptions,
): Promise<DraftOutlineItem[]> {
  const data = await chatJson<Array<{ heading?: unknown; description?: unknown }>>(
    settings,
    buildOutlineMessages(opts),
  );
  const outline = (Array.isArray(data) ? data : []).map((o) => ({
    heading: String(o.heading ?? '').trim(),
    description: String(o.description ?? '').trim(),
  }));
  const valid = outline.filter((o) => o.heading);
  if (valid.length === 0) throw new Error('LLM 未返回有效大纲');
  return valid;
}

/** 调用 LLM 撰写单个小节（LaTeX 源码）。 */
export async function writeSection(
  settings: PaperSettings,
  opts: OutlineOptions,
  outline: DraftOutlineItem[],
  item: DraftOutlineItem,
): Promise<string> {
  const text = await chatText(settings, buildSectionMessages(opts, outline, item));
  return text.trim();
}

export type DraftExportFormat = 'docx' | 'md' | 'tex' | 'bib';

export interface ExportDraftInput {
  title: string;
  username: string;
  sections: DraftSection[];
  /** 参考论文（含主论文），用于生成 \\cite 映射与 .bib */
  references: PaperRecord[];
}

/** 生成 BibTeX key：外部 id 或论文记录 id 前 8 位（允许 . 和 -，arXiv id 含点）；重名时加序号。 */
function bibKey(p: PaperRecord, index: number, used: Set<string>): string {
  const base = (p.externalId || p.id).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || `ref${index}`;
  let key = base;
  let i = 1;
  while (used.has(key)) key = `${base}${i++}`;
  used.add(key);
  return key;
}

/** 生成 .bib 内容（纯函数，供单测）。 */
export function buildBibtex(references: PaperRecord[]): string {
  const used = new Set<string>();
  const entries = references.map((p, i) => {
    const key = bibKey(p, i, used);
    const author = p.authors.length
      ? p.authors.join(' and ')
      : 'Unknown';
    const fields: string[] = [
      `  title = {${p.title}}`,
      `  author = {${author}}`,
      `  year = {${p.year ?? ''}}`,
      `  journal = {${p.venue ?? 'arXiv preprint'}}`,
    ];
    if (p.externalId && p.source === 'arxiv') fields.push(`  eprint = {${p.externalId}}`, '  archivePrefix = {arXiv}');
    if (p.url) fields.push(`  url = {${p.url}}`);
    return `@article{${key},\n${fields.join(',\n')}\n}`;
  });
  return entries.join('\n\n') + '\n';
}

/**
 * 生成 LaTeX 正文：\cite{key} 中的 ref1/ref2… 映射为参考论文的 BibTeX key。
 * 纯函数，供单测。
 */
export function mapCitations(body: string, references: PaperRecord[]): string {
  if (references.length === 0) return body;
  const used = new Set<string>();
  const keys = references.map((p, i) => bibKey(p, i, used));
  return body.replace(/\\cite\{ref(\d+)\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    if (idx < 0 || idx >= keys.length) return _m;
    return `\\cite{${keys[idx]}}`;
  });
}

/** 组装 .tex 主文档（中文支持：ctex；不含 .bib 时也附完整结构）。 */
export function buildLatexDoc(input: ExportDraftInput): string {
  const lines: string[] = [];
  lines.push('% Generated by PaperStudio', '\\documentclass[11pt]{article}', '');
  lines.push('% 中文支持（Windows 推荐 xelatex 编译）');
  lines.push('\\usepackage[UTF8]{ctex}', '\\usepackage[margin=1in]{geometry}', '\\usepackage{amsmath,amssymb}');
  lines.push('\\usepackage{hyperref}', '');
  lines.push(`\\title{${input.title.replace(/([\\{}])/g, '\\$1')}}`);
  lines.push(`\\author{${input.username || 'Anonymous'}}`, '\\date{\\today}', '');
  lines.push('\\begin{document}', '\\maketitle', '');
  for (const s of input.sections) {
    lines.push(`\\section{${s.heading.replace(/([\\{}])/g, '\\$1')}}`, '');
    lines.push(mapCitations(s.content.trim(), input.references), '');
  }
  if (input.references.length > 0) {
    lines.push('\\bibliographystyle{plain}', '\\bibliography{refs}', '');
  }
  lines.push('\\end{document}', '');
  return lines.join('\n');
}

/** 把草稿导出为指定格式，写入 dir；返回文件绝对路径。 */
export async function exportDraft(
  input: ExportDraftInput,
  format: DraftExportFormat,
  dir: string,
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const safe = input.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'draft';
  const ext = { docx: 'docx', md: 'md', tex: 'tex', bib: 'tex' }[format];
  const filePath = path.join(dir, format === 'bib' ? 'refs.bib' : `${safe}.${ext}`);
  if (format === 'tex') {
    fs.writeFileSync(filePath, buildLatexDoc(input), 'utf8');
    if (input.references.length > 0) {
      fs.writeFileSync(path.join(dir, 'refs.bib'), buildBibtex(input.references), 'utf8');
    }
    return filePath;
  }
  if (format === 'bib') {
    fs.writeFileSync(filePath, buildBibtex(input.references), 'utf8');
    return filePath;
  }
  if (format === 'md') {
    const md = [`# ${input.title}`, ''];
    for (const s of input.sections) {
      md.push(`## ${s.heading}`, '', s.content.trim(), '');
    }
    fs.writeFileSync(filePath, md.join('\n'), 'utf8');
    return filePath;
  }
  // docx：动态 import（docx 为 CJS 包，主进程可用）
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
  ];
  for (const s of input.sections) {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }));
    for (const block of splitMarkdown(s.content)) {
      if (block.startsWith('- ')) {
        children.push(new Paragraph({ text: block.slice(2), bullet: { level: 0 } }));
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block,
                bold: /^\*\*[\s\S]*\*\*$/.test(block),
              }),
            ],
            spacing: { after: 120 },
          }),
        );
      }
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/** 简易 markdown 段落拆分（按空行/换行，过滤空段）。 */
function splitMarkdown(text: string): string[] {
  return text
    .split(/\n{1,}/)
    .map((l) => l.trim())
    .filter(Boolean);
}