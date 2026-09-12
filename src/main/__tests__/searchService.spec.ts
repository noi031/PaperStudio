// searchService.ts 单测：arXiv Atom 解析、S2 JSON 解析、合并去重、标题归一化、URL 安全文件名。
import { describe, it, expect } from 'vitest';
import {
  parseArxivAtom,
  parseS2Json,
  mergeHits,
  normalizeTitle,
  safeFileNameFromUrl,
} from '../searchService';

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>  A   Great  Paper   on RAG  </title>
    <summary>  This is   the abstract of the paper.   </summary>
    <author><name>Alice Chen</name></author>
    <author><name>Bob Liu</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2312.99999</id>
    <published>2023-12-31T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Abstract two.</summary>
  </entry>
</feed>`;

const S2_JSON = {
  data: [
    {
      paperId: 's2-paper-1',
      title: 'A Great Paper on RAG',
      abstract: 'S2 abstract',
      year: 2024,
      venue: 'ACL',
      authors: [{ name: 'Alice Chen' }],
      externalIds: { ArXiv: '2401.12345' },
      openAccessPdf: { url: 'https://example.com/pdf/2401.12345.pdf' },
      url: 'https://www.semanticscholar.org/paper/1',
    },
    {
      paperId: 's2-paper-2',
      title: 'No PDF Paper',
      year: 2023,
      venue: null,
      abstract: null,
      authors: [],
      externalIds: {},
      openAccessPdf: null,
      url: null,
    },
  ],
};

describe('parseArxivAtom', () => {
  it('解析标题/摘要/作者/日期，推导 pdfUrl', () => {
    const hits = parseArxivAtom(ARXIV_XML);
    expect(hits).toHaveLength(2);
    const h = hits[0];
    expect(h.source).toBe('arxiv');
    expect(h.externalId).toBe('2401.12345v2');
    expect(h.title).toBe('A Great Paper on RAG');
    expect(h.authors).toEqual(['Alice Chen', 'Bob Liu']);
    expect(h.year).toBe(2024);
    expect(h.pdfUrl).toBe('https://arxiv.org/pdf/2401.12345v2');
  });

  it('无 id 的 entry 被忽略', () => {
    const hits = parseArxivAtom('<feed><entry><title>x</title></entry></feed>');
    expect(hits).toHaveLength(0);
  });
});

describe('parseS2Json', () => {
  it('解析 S2 响应并优先用 arXiv externalId', () => {
    const hits = parseS2Json(S2_JSON);
    expect(hits).toHaveLength(2);
    expect(hits[0].source).toBe('semantic_scholar');
    expect(hits[0].externalId).toBe('2401.12345');
    expect(hits[0].pdfUrl).toBe('https://example.com/pdf/2401.12345.pdf');
    expect(hits[0].venue).toBe('ACL');
  });

  it('缺字段回退为 null/空', () => {
    const hits = parseS2Json(S2_JSON);
    expect(hits[1].pdfUrl).toBeNull();
    expect(hits[1].venue).toBeNull();
    expect(hits[1].authors).toEqual([]);
  });

  it('非数组 data 返回空数组', () => {
    expect(parseS2Json({ data: 'nope' })).toEqual([]);
    expect(parseS2Json({})).toEqual([]);
  });
});

describe('mergeHits / normalizeTitle', () => {
  it('标题归一化：小写、去空白标点', () => {
    expect(normalizeTitle('A Great Paper on RAG!')).toBe('agreatpaperonrag');
    expect(normalizeTitle('中文 标题。')).toBe('中文标题');
  });

  it('arXiv 与 S2 同 arXiv id 合并为一条，并集补齐字段', () => {
    const arxiv = parseArxivAtom(ARXIV_XML)[0];
    const s2 = parseS2Json(S2_JSON)[0];
    const merged = mergeHits([arxiv, s2]);
    expect(merged).toHaveLength(1);
    expect(merged[0].venue).toBe('ACL'); // 来自 S2
    expect(merged[0].abstract).toBe('S2 abstract'); // S2 在前则用 S2
    expect(merged[0].authors).toEqual(['Alice Chen']); // S2 有作者则用 S2
  });

  it('无 arXiv id 时按归一化标题去重', () => {
    const a = {
      source: 'semantic_scholar' as const,
      externalId: 'x',
      title: 'Same Title',
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      url: null,
      pdfUrl: null,
    };
    const b = { ...a, externalId: 'y', abstract: '补丁摘要' };
    const merged = mergeHits([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].abstract).toBe('补丁摘要');
  });
});

describe('safeFileNameFromUrl', () => {
  it('从 URL 取安全文件名（最后一段，去扩展名）', () => {
    expect(safeFileNameFromUrl('https://arxiv.org/pdf/2401.12345v2')).toBe('2401.12345v2');
    expect(safeFileNameFromUrl('https://example.com/a b/c.pdf')).toBe('c');
  });
  it('空 URL 回退 paper', () => {
    expect(safeFileNameFromUrl(null)).toBe('paper');
    expect(safeFileNameFromUrl('')).toBe('paper');
  });
});
