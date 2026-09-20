import { describe, it, expect } from 'vitest';
import { renderLatexHtml, latexToMarkdown } from '../../shared/latexPreview.js';

// 用户报告的模板：equation 环境含 \label，以及内嵌 aligned、行内/块级公式
const SAMPLE = `如下式所示：
\\begin{equation}
\\mathcal{L} = -\\sum_{(h,r,t) \\in \\mathcal{G}} \\left[ \\log \\sigma\\bigl(\\phi(h,r,t)\\bigr) \\right],
\\label{eq:neg-loss}
\\end{equation}
另一式 \\begin{align}
a &= b \\\\
c &= d
\\end{align}
行内 \\(x^2\\) 与 block \\[E=mc^2\\]。

\\begin{itemize}
\\item 第一点
\\item 第二点
\\end{itemize}`;

describe('latexPreview 数学环境', () => {
  it('renderLatexHtml：equation/align 环境整体 KaTeX 渲染，无 katex-error', () => {
    const html = renderLatexHtml(SAMPLE);
    expect(html).not.toContain('katex-error');
    expect(html).toContain('katex-display');
    // 数学命令不应以裸文本残留
    expect(html).not.toContain('\\begin{equation}');
    expect(html).not.toContain('\\label');
    // 列表转换
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
  });

  it('latexToMarkdown：数学内容先占位保护，\sigma 等命令不被剥掉', () => {
    const md = latexToMarkdown(SAMPLE);
    // equation/align 环境 → 块级 $$…$$（aligned 包裹），数学命令完整保留
    expect(md).toContain('\\begin{aligned}');
    expect(md).toContain('\\mathcal{L}');
    expect(md).toContain('\\sigma');
    expect(md).toContain('\\phi');
    // 环境与 label 已转换/剥离
    expect(md).not.toContain('\\begin{equation}');
    expect(md).not.toContain('\\label');
    // 行内公式 \(…\) → $…$；块级 \[…\] → $$…$$
    expect(md).toContain('$x^2$');
    expect(md).toContain('E=mc^2');
    expect(md).not.toContain('\\[');
    // 列表 → markdown
    expect(md).toContain('- 第一点');
  });

  it('LaTeX 的 ~~ 双空格不会被渲染成删除线', () => {
    const src = `引言 ~~ 之后的正文，以及 \\texttt{a\\_b} 样例。`;
    const md = latexToMarkdown(src);
    expect(md).not.toContain('~~');
    const html = renderLatexHtml(src);
    expect(html).not.toContain('<del>');
    expect(html).not.toContain('~~');
  });

  it('两条路径渲染同一公式结果一致：md 中的 $$ 数学块即 KaTeX 可渲染内容', async () => {
    const md = latexToMarkdown(SAMPLE);
    const block = md.match(/\$\$\n?([\s\S]*?)\n?\$\$/)?.[1] ?? '';
    expect(block).toContain('\\mathcal{L}');
    // 该内容可直接交给 kaTeX 渲染成功（aligned 包裹、label 已剥离）
    const katex = await import('katex');
    const html = katex.renderToString(block, { displayMode: true, throwOnError: false, strict: false });
    expect(html).not.toContain('katex-error');
  });
});