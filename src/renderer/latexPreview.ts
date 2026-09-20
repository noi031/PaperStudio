// 写作页 LaTeX 源码预览：
//  - renderLatexHtml：小节内容 → HTML（$...$ 数学用 KaTeX 渲染，常用命令轻量转换）
//  - latexToMarkdown：小节内容 → Markdown（数学 $...$ 保留，交给服务端 KaTeX，用于整篇预览弹窗）
import katex from 'katex';
import 'katex/dist/katex.min.css';

const MATH_BLOCK_RE = /\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE_RE = /\$([^$\n]+?)\$/g;
// LaTeX 环境：\[...\] 块级显示公式、\(...\) 行内公式
const MATH_DISPLAY_BRACKET_RE = /\\\[([\s\S]+?)\\\]/g;
const MATH_INLINE_PAREN_RE = /\\\(([^()\n]+?)\\\)/g;
// 数学环境（含带 * 编号变体）：内层 aligned/gathered/split 先处理，外层 equation/align/… 后处理
const MATH_ENV_INNER_RE = /\\begin\{(aligned|gathered|split)\}([\s\S]*?)\\end\{\1\}/g;
const MATH_ENV_OUTER_RE = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*?)\\end\{\1\}/g;

/** 数学环境体预处理：去掉 \label{}（KaTeX 不支持），保留其他。 */
function cleanMathEnv(body: string): string {
  return body
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\nonumber/g, '')
    .trim();
}

/** 命令替换表：LaTeX 命令 → HTML/Markdown（对整段源码做正则全局替换）。 */
function applyCommands(src: string, html: boolean): string {
  const bold = html ? '<b>$1</b>' : '**$1**';
  const italic = html ? '<i>$1</i>' : '*$1*';
  const code = html ? '<code>$1</code>' : '`$1`';
  const cite = html ? '<span class="cite">[$1]</span>' : '[$1]';
  let out = src;
  // 列表环境：itemize/enumerate → <ul>/<ol>（md 转 - 列表），\item → <li>
  if (html) {
    out = out
      .replace(/\\begin\{itemize\}/g, '<ul>')
      .replace(/\\end\{itemize\}/g, '</ul>')
      .replace(/\\begin\{enumerate\}/g, '<ol>')
      .replace(/\\end\{enumerate\}/g, '</ol>');
    out = out.replace(/\\item\s*/g, '<li>');
    // 列表结束时给最后一个 \item 补闭合（多项时各 \item 依次嵌套，预览可接受）
    out = out.replace(/<li>([\s\S]*?)<\/ul>/g, '<li>$1</li></ul>');
    out = out.replace(/<li>([\s\S]*?)<\/ol>/g, '<li>$1</li></ol>');
  } else {
    out = out
      .replace(/\\begin\{itemize\}/g, '\n')
      .replace(/\\end\{itemize\}/g, '\n')
      .replace(/\\begin\{enumerate\}/g, '\n')
      .replace(/\\end\{enumerate\}/g, '\n');
    out = out.replace(/\\item\s*/g, '- ');
  }
  // \textbf/\mathbf/\textsf/\texttt{...}
  out = out.replace(/\\(?:textbf|mathbf|textsf|texttt)\{([^{}]*)\}/g, bold);
  out = out.replace(/\\(?:textit|emph|textsl)\{([^{}]*)\}/g, italic);
  out = out.replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, '$1');
  out = out.replace(/\\cite\{([^}]*)\}/g, cite);
  out = out.replace(/\\ref\{([^}]*)\}/g, html ? '<span class="cite">图/式 $1</span>' : '图/式 $1');
  out = out.replace(/\\(?:label|tag)\{[^}]*\}/g, '');
  // 无条件/参数较少的有用命令
  out = out.replace(/\\section\*?\{([^}]*)\}/g, html ? '<h3>$1</h3>' : '### $1');
  out = out.replace(/\\subsection\*?\{([^}]*)\}/g, html ? '<h4>$1</h4>' : '#### $1');
  out = out.replace(/\\paragraph\{([^}]*)\}/g, html ? '<b>$1</b>' : '**$1**');
  out = out.replace(/\\quad/g, '　');
  out = out.replace(/\\qquad/g, '　　');
  out = out.replace(/\\,|\\;/g, ' ');
  // 常见转义还原
  out = out.replace(/\\%/g, '%').replace(/\\&/g, '&').replace(/\\_/g, '_').replace(/\\#/g, '#');
  out = out.replace(/\\textasciitilde/g, '~');
  // 剩下的未知命令：若带 {…} 保留参数、去掉命令；无参数命令直接去掉
  out = out.replace(/\\([a-zA-Z]+)\{([^{}]*)\}/g, '$2');
  out = out.replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, '');
  // 环境
  out = html ? out.replace(/\\begin\{[^}]*\}/g, '').replace(/\\end\{[^}]*\}/g, '') : out;
  return out;
}

/** 小节 LaTeX 源码 → HTML（数学用 KaTeX，常用命令转换）。 */
export function renderLatexHtml(src: string): string {
  let html = src;
  // 数学环境统一收集为占位符，避免与其余内容交错：
  // 顺序：内层数学环境 → 外层数学环境 → $$…$$ → \[…\]（块级）→ $…$ → \(…\)（行内）
  const blocks: string[] = [];
  const render = (raw: string, displayMode: boolean, clean = (b: string) => b): string => {
    const rendered = katex.renderToString(clean(raw), { displayMode, throwOnError: false, strict: false });
    blocks.push(rendered);
    return `\u0000K${blocks.length - 1}\u0000`;
  };
  html = html.replace(MATH_ENV_INNER_RE, (_m, _env, body) => render(body, true, cleanMathEnv));
  html = html.replace(MATH_ENV_OUTER_RE, (_m, _env, body) => render(body, true, cleanMathEnv));
  html = html.replace(MATH_BLOCK_RE, (_m, body) => render(body, true));
  html = html.replace(MATH_DISPLAY_BRACKET_RE, (_m, body) => render(body, true));
  html = html.replace(MATH_INLINE_RE, (_m, body) => render(body, false));
  html = html.replace(MATH_INLINE_PAREN_RE, (_m, body) => render(body, false));
  html = applyCommands(html, true);
  html = html.replace(/\u0000K(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '');
  // 段落：空行分段
  const paras = html
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
  return paras || html;
}

/** 小节 LaTeX 源码 → Markdown（数学统一转为 $…$/$$…$$，交给服务端 KaTeX，整篇预览弹窗用）。 */
export function latexToMarkdown(src: string): string {
  let md = src;
  const envToBlock = (re: RegExp): void => {
    md = md.replace(re, (_m, _env: string, body: string) => `$$\n${cleanMathEnv(body)}\n$$`);
  };
  envToBlock(MATH_ENV_INNER_RE);
  envToBlock(MATH_ENV_OUTER_RE);
  md = md.replace(MATH_DISPLAY_BRACKET_RE, '$$\n$1\n$$');
  md = md.replace(MATH_INLINE_PAREN_RE, '$$1$$');
  md = applyCommands(md, false);
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

/** 章节标题 LaTeX → 纯文本（大纲/全文预览用）。 */
export function latexHeadingToText(src: string): string {
  return applyCommands(src, false).replace(/[#*`]/g, '').trim();
}