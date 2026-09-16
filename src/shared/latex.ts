// LaTeX → 可读纯文本的轻量转换。
// 用途：arXiv 摘要/标题含大量 $...$ 数学记号，AI 总结也会带 \(...\) LaTeX，
// 直接展示像乱码。此工具只做「能读」级别的转换：剥分隔符、替换常用宏、
// 处理上下标与分式，不追求完整 LaTeX 渲染。
//
// 处理顺序（顺序敏感）：
//   1 剥数学环境分隔符 → 2 清 \begin/\end 环境标签 → 3 尺寸/括号命令
//   → 4 替换希腊字母与符号宏（长键优先）→ 5 展开 \cmd{arg} → 6 上下标 → 7 清理

const GREEK: Record<string, string> = {
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
  '\\epsilon': 'ε', '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η',
  '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
  '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ',
  '\\pi': 'π', '\\rho': 'ρ', '\\sigma': 'σ', '\\tau': 'τ',
  '\\upsilon': 'υ', '\\phi': 'φ', '\\varphi': 'φ', '\\chi': 'χ',
  '\\psi': 'ψ', '\\omega': 'ω',
  '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
  '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ',
  '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
};

const SYMBOLS: Record<string, string> = {
  '\\mathbb{R}': 'ℝ', '\\mathbb{Z}': 'ℤ', '\\mathbb{N}': 'ℕ',
  '\\mathbb{Q}': 'ℚ', '\\mathbb{C}': 'ℂ',
  '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐',
  '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔', '\\to': '→', '\\mapsto': '↦',
  '\\cdot': '·', '\\times': '×', '\\pm': '±', '\\mp': '∓', '\\div': '÷',
  '\\leq': '≤', '\\geq': '≥', '\\leqslant': '≤', '\\geqslant': '≥',
  '\\approx': '≈', '\\neq': '≠', '\\ne': '≠', '\\equiv': '≡', '\\propto': '∝',
  '\\sim': '∼', '\\simeq': '≃', '\\cong': '≅', '\\infty': '∞',
  '\\partial': '∂', '\\nabla': '∇', '\\in': '∈', '\\notin': '∉',
  '\\subset': '⊂', '\\subseteq': '⊆', '\\supset': '⊃', '\\supseteq': '⊇',
  '\\cup': '∪', '\\cap': '∩', '\\oplus': '⊕', '\\otimes': '⊗',
  '\\ldots': '…', '\\cdots': '⋯', '\\dots': '…',
  '\\circ': '°', '\\degree': '°', '\\dagger': '†', '\\ddagger': '‡',
  '\\ast': '*', '\\star': '⋆', '\\parallel': '∥', '\\perp': '⊥',
  '\\langle': '⟨', '\\rangle': '⟩', '\\mid': '|', '\\hbar': 'ℏ',
  '\\prime': '′', '\\%': '%', '\\&': '&', '\\_': '_', '\\{': '{', '\\}': '}', '\\#': '#',
  '\\$': '$', '\\ ': ' ', '\\,': ' ', '\\;': ' ', '\\!': ' ', '\\:': ' ',
  '\\quad': '  ', '\\qquad': '  ', '\\enspace': ' ',
  // 注意：\sqrt 不在符号表里，留给 unwrapCommands 转成 √(...)
};

function sup(s: string): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ', 'm': 'ᵐ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ', 'T': 'ᵀ', '*': '∗' };
  return [...s].map((c) => map[c] ?? map[c.toLowerCase()] ?? c).join('');
}

function sub(s: string): string {
  const map: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ', 'y': 'ᵧ' };
  return [...s].map((c) => map[c] ?? map[c.toLowerCase()] ?? c).join('');
}

/** 展开 \cmd{arg} 类命令（不处理嵌套，展示级足够）。 */
function unwrapCommands(s: string): string {
  // 文本/字形包装命令 → 内容
  s = s.replace(
    /\\(?:mathrm|text|mathbf|boldsymbol|mathit|textbf|textrm|operatorname|mathcal|mathscr|mathfrak)\{([^{}]*)\}/g,
    '$1',
  );
  // 分式
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
  // 根式
  s = s.replace(/\\sqrt\[([^{}]*)\]\{([^{}]*)\}/g, '$1√($2)');
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  // 帽子/向量/上下划线 → 内容
  s = s.replace(
    /\\(?:overline|underline|hat|widehat|tilde|widetilde|bar|vec|dot|ddot|bm|bold)\{([^{}]*)\}/g,
    '$1',
  );
  // 剩余 \cmd{arg} 取内容
  s = s.replace(/\\(?:[a-zA-Z]+)\{([^{}]*)\}/g, '$1');
  return s;
}

/** 把一段含 LaTeX 的文本转成可读纯文本。 */
export function latexToText(src: string | null | undefined): string {
  if (!src) return src ?? '';
  let s = src;
  // 1) 数学环境分隔符：剥掉 $...$ / $$...$$ / \(...\) / \[...\]，保留内容
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, c: string) => c.trim());
  s = s.replace(/\$([^$]*?)\$/g, (_, c: string) => c.trim());
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, c: string) => c.trim());
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, c: string) => c.trim());
  // 2) \begin{...}...\end{...} 环境标签
  s = s.replace(/\\begin\{[a-zA-Z*]+\}/g, ' ').replace(/\\end\{[a-zA-Z*]+\}/g, ' ');
  // 3) 显式尺寸/括号命令
  s = s.replace(
    /\\(?:left|right|big|Big|bigg|Bigg|lvert|rvert|lVert|rVert|middle)\b/g,
    ' ',
  );
  // 4) 希腊字母与符号宏（长键优先，避免 \rightarrow 被 \to 提前吃掉）。
  //    单次正则扫描替换（旧的逐宏 split/join 是对全文 O(宏数×n) 的重扫描，
  //    长文本流式渲染时会造成主线程卡顿）。
  const macros: Record<string, string> = {};
  for (const [k, v] of [...Object.entries(GREEK), ...Object.entries(SYMBOLS)].sort((a, b) => b[0].length - a[0].length)) {
    macros[k] = v;
  }
  const macroRe = new RegExp(Object.keys(macros).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  s = s.replace(macroRe, (m) => macros[m] ?? m);
  // 5) \cmd{arg} 展开
  s = unwrapCommands(s);
  // 6) 上下标（先带花括号，再单个字符；内容先去空白）
  s = s.replace(/\^\{([^{}]*)\}/g, (_, c: string) => sup(c.replace(/\s+/g, '')));
  s = s.replace(/_\{([^{}]*)\}/g, (_, c: string) => sub(c.replace(/\s+/g, '')));
  s = s.replace(/\^([^\\{}])/g, (_, c: string) => sup(c));
  s = s.replace(/_([^\\{}])/g, (_, c: string) => sub(c));
  // 7) 清理剩余裸命令与花括号
  s = s.replace(/\\(?:[a-zA-Z]+)/g, '');
  s = s.replace(/[{}\\]/g, '');
  s = s.replace(/\s+([→←⇒⇔↔±∓])\s+/g, '$1');
  s = s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  return s.replace(/\s+/g, ' ').trim();
}
