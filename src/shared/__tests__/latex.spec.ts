import { describe, expect, it } from 'vitest';
import { latexToText } from '../latex';

describe('latexToText', () => {
  it('strips inline math delimiters', () => {
    expect(latexToText('The angle $\\gamma$ is measured')).toBe('The angle γ is measured');
  });

  it('handles arXiv-style abstracts with rich LaTeX', () => {
    const abs =
      'A search for the rare decays $W^{+}\\rightarrow{D^{+}_{s}\\gamma}$ and $Z\\rightarrow{D^{0}\\gamma}$ is performed with 2.0 fb$^{-1}$.';
    expect(latexToText(abs)).toBe(
      'A search for the rare decays W⁺→D⁺ₛγ and Z→D⁰γ is performed with 2.0 fb⁻¹.',
    );
  });

  it('handles \\frac and nested commands', () => {
    expect(latexToText('$\\frac{a}{b}$ and $\\sqrt{x}$')).toBe('(a)/(b) and √(x)');
    expect(latexToText('$\\mathbb{R}^{n}$')).toBe('ℝⁿ');
  });

  it('handles display math and environments', () => {
    expect(latexToText('$$\\alpha + \\beta$$ end')).toBe('α + β end');
    expect(latexToText('\\begin{equation}E=mc^2\\end{equation}')).toBe('E=mc²');
  });

  it('handles \\text{} and \\mathrm{} wrappers', () => {
    expect(latexToText('$K_{\\mathrm{S(L)}}^0\\to\\mu^+\\mu^-$')).toBe('Kₛ₍ₗ₎⁰→μ⁺μ⁻');
  });

  it('cleans \\(...\\) LaTeX from AI summaries', () => {
    const summary =
      '测量 CKM 角 \\(B^\\pm \\to D(K^0_S h^{\\prime +}h^{\\prime -}) h^\\pm\\) 衰变中的 γ 角';
    expect(latexToText(summary)).toBe('测量 CKM 角 B±→D(K⁰ₛ h′⁺h′⁻) h± 衰变中的 γ 角');
  });

  it('leaves plain text untouched', () => {
    expect(latexToText('这是一段普通中文摘要，包含 CKM 角 γ。')).toBe('这是一段普通中文摘要，包含 CKM 角 γ。');
  });

  it('handles null/undefined', () => {
    expect(latexToText(null)).toBe('');
    expect(latexToText(undefined)).toBe('');
    expect(latexToText('')).toBe('');
  });
});
