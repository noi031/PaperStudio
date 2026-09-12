import { describe, expect, it } from 'vitest';
import { buildDirectionMessages } from '../directionService';
import {
  buildOutlineMessages,
  buildSectionMessages,
  buildReferencesText,
  buildBibtex,
  buildLatexDoc,
  mapCitations,
} from '../writingService';
import { buildSlidesMessages } from '../presentationService';
import { extractJson, repairJsonEscapes } from '../llm';
import type { PaperRecord } from '../../shared/types';

const paper: PaperRecord = {
  id: 'p1',
  title: 'A Test Paper on $\\gamma$ decays',
  authors: ['Alice', 'Bob'],
  year: 2024,
  venue: 'arXiv',
  abstract: 'We measure the CKM angle $\\gamma$ with $B^\\pm \\to D h^\\pm$ decays.',
  source: 'arxiv',
  externalId: '2401.00001',
  url: null,
  pdfUrl: null,
  pdfPath: null,
  addedAt: 0,
};

const ref2: PaperRecord = { ...paper, id: 'p2', title: 'Second Ref', externalId: '2402.00002' };

const opts = (p: PaperRecord | null, refs: PaperRecord[]) => ({ paper: p, references: refs });

describe('directionService.buildDirectionMessages', () => {
  it('把论文列表组装进 user 消息', () => {
    const msgs = buildDirectionMessages([paper, { ...paper, id: 'p2', title: 'Second' }]);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('A Test Paper on');
    expect(msgs[1].content).toContain('2 篇论文');
    expect(msgs[1].content).toContain('Second');
  });
});

describe('writingService message builders（多篇参考 + LaTeX）', () => {
  it('buildReferencesText 多篇带 [refN] 序号', () => {
    const text = buildReferencesText([paper, ref2], 2000);
    expect(text).toContain('[ref1] A Test Paper');
    expect(text).toContain('[ref2] Second Ref');
  });

  it('buildOutlineMessages 含主论文 + 参考论文', () => {
    const msgs = buildOutlineMessages(opts(paper, [ref2]));
    expect(msgs[1].content).toContain('A Test Paper');
    expect(msgs[1].content).toContain('Second Ref');
    expect(msgs[1].content).toContain('[ref2]');
    expect(msgs[0].content).toContain('参考');
  });

  it('buildOutlineMessages 无主论文时仅用参考论文', () => {
    const msgs = buildOutlineMessages(opts(null, [ref2]));
    expect(msgs[1].content).toContain('Second Ref');
    expect(msgs[1].content).not.toContain('A Test Paper');
  });

  it('buildSectionMessages 指定小节并要求 LaTeX', () => {
    const outline = [
      { heading: '引言', description: '背景' },
      { heading: '方法', description: '实验' },
    ];
    const msgs = buildSectionMessages(opts(paper, [ref2]), outline, outline[1]);
    expect(msgs[1].content).toContain('第 2 节');
    expect(msgs[1].content).toContain('方法');
    expect(msgs[1].content).toContain('[ref1]');
    expect(msgs[0].content).toContain('LaTeX');
    expect(msgs[0].content).toContain('\\cite');
  });
});

describe('writingService LaTeX 导出', () => {
  it('buildBibtex 生成 @article 条目（含 arXiv eprint）', () => {
    const bib = buildBibtex([paper, ref2]);
    expect(bib).toContain('@article{2401.00001,');
    expect(bib).toContain('@article{2402.00002,');
    expect(bib).toContain('eprint = {2401.00001}');
    expect(bib).toContain('archivePrefix = {arXiv}');
    expect(bib).toContain('Alice and Bob');
  });

  it('buildBibtex 重名 key 自动去重', () => {
    const a: PaperRecord = { ...paper, id: 'x1', externalId: 'same', title: 'A' };
    const b: PaperRecord = { ...ref2, id: 'x2', externalId: 'same', title: 'B' };
    const bib = buildBibtex([a, b]);
    expect(bib.match(/@article\{same[,}]/g)?.length).toBe(1);
    expect(bib).toContain('@article{same1,');
  });

  it('mapCitations 把 \\cite{refN} 映射为 BibTeX key', () => {
    const body = '方法详见 \\cite{ref1} 与 \\cite{ref2}。';
    const mapped = mapCitations(body, [paper, ref2]);
    expect(mapped).toContain('\\cite{2401.00001}');
    expect(mapped).toContain('\\cite{2402.00002}');
    // 越界 ref 原样保留
    expect(mapCitations('\\cite{ref9}', [paper])).toContain('\\cite{ref9}');
  });

  it('buildLatexDoc 组装完整文档（ctex/\\section/\\bibliography）', () => {
    const doc = buildLatexDoc({
      title: 'My Paper',
      username: 'me',
      sections: [{ heading: '引言', content: '背景见 \\cite{ref1}，$E=mc^2$。' }],
      references: [paper],
    });
    expect(doc).toContain('\\documentclass[11pt]{article}');
    expect(doc).toContain('\\usepackage[UTF8]{ctex}');
    expect(doc).toContain('\\title{My Paper}');
    expect(doc).toContain('\\author{me}');
    expect(doc).toContain('\\section{引言}');
    expect(doc).toContain('\\cite{2401.00001}');
    expect(doc).toContain('\\bibliography{refs}');
    expect(doc).toContain('\\end{document}');
  });
});

describe('presentationService.buildSlidesMessages', () => {
  it('包含论文信息', () => {
    const msgs = buildSlidesMessages(paper);
    expect(msgs[1].content).toContain('A Test Paper');
    expect(msgs[0].content).toContain('幻灯片');
  });
});

describe('llm.extractJson / repairJsonEscapes', () => {
  it('直接 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('json 代码块', () => {
    expect(extractJson('```json\n[{"x":2}]\n```')).toEqual([{ x: 2 }]);
  });
  it('带前后缀噪声', () => {
    expect(extractJson('好的，结果如下：{"a":1} 希望对你有帮助')).toEqual({ a: 1 });
  });
  it('非法 JSON 抛错', () => {
    expect(() => extractJson('not json at all')).toThrow();
  });
  it('LaTeX 非法转义 \\g 修复（\\gamma 保留字面量）', () => {
    const repaired = repairJsonEscapes('{"d":"$\\gamma$"}');
    expect(JSON.parse(repaired)).toEqual({ d: '$\\gamma$' });
    expect(extractJson('{"d":"$\\gamma$ 与 $B^\\pm$"}')).toEqual({ d: '$\\gamma$ 与 $B^\\pm$' });
  });
  it('合法 JSON（含 \\\\ 与 \\"）直接解析不破坏', () => {
    expect(extractJson('{"a":"x\\\\y\\"z"}')).toEqual({ a: 'x\\y"z' });
  });
  it('repairJsonEscapes 对 \\t \\b 按 LaTeX 字面量双写（兜底路径）', () => {
    expect(repairJsonEscapes('{"d":"\\textbf{ML} 与 $\\beta$"}')).toBe('{"d":"\\\\textbf{ML} 与 $\\\\beta$"}');
    // 兜底修复后 parse 得到原样 LaTeX
    expect(JSON.parse(repairJsonEscapes('{"d":"\\textbf{ML}"}'))).toEqual({ d: '\\textbf{ML}' });
  });
  it('\\uXXXX 合法转义保留', () => {
    expect(repairJsonEscapes('{"a":"\\u4e2d\\u6587"}')).toBe('{"a":"\\u4e2d\\u6587"}');
    expect(extractJson('{"a":"\\u4e2d"}')).toEqual({ a: '中' });
  });
  it('LaTeX 数组大纲整体可解析', () => {
    const raw = '[{"heading":"引言","description":"背景含 $\\gamma$ decay"},{"heading":"方法","description":"用 \\textbf{ML} 拟合"}]';
    const out = extractJson<Array<{ heading: string; description: string }>>(raw);
    expect(out.length).toBe(2);
    expect(out[0].description).toContain('$\\gamma$');
    expect(out[1].description).toContain('\\textbf{ML}');
  });
});
