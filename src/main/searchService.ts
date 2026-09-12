// P3 检索服务：arXiv + Semantic Scholar 并发检索、解析、合并去重、PDF 下载。
// 纯函数（parseArxivAtom/parseS2Json/mergeHits）独立导出供单测；网络入口 search/downloadPdf。
import fs from 'node:fs';
import path from 'node:path';
import type { PaperHit } from '../shared/types.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';
const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';

/** 解析 arXiv Atom XML → PaperHit[]（纯函数）。 */
export function parseArxivAtom(xml: string): PaperHit[] {
  const hits: PaperHit[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const get = (tag: string) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
    const idUrl = get('id').trim();
    const id = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
    if (!id) continue;
    const title = get('title').replace(/\s+/g, ' ').trim();
    const abstract = get('summary').replace(/\s+/g, ' ').trim();
    const published = get('published').slice(0, 10);
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => a[1].trim());
    hits.push({
      source: 'arxiv',
      externalId: id,
      title,
      authors,
      year: published ? Number(published.slice(0, 4)) || null : null,
      venue: null,
      abstract: abstract || null,
      url: idUrl || `https://arxiv.org/abs/${id}`,
      pdfUrl: `https://arxiv.org/pdf/${id}`,
    });
  }
  return hits;
}

/** 解析 Semantic Scholar Graph API search 响应 JSON → PaperHit[]（纯函数）。 */
export function parseS2Json(json: unknown): PaperHit[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const hits: PaperHit[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    const paperId = typeof item.paperId === 'string' ? item.paperId : '';
    if (!paperId) continue;
    const ext = (item.externalIds ?? {}) as Record<string, unknown>;
    const arxivId = typeof ext.ArXiv === 'string' ? ext.ArXiv : null;
    const openPdf = (item.openAccessPdf ?? {}) as { url?: unknown } | null;
    const pdfUrl = typeof openPdf?.url === 'string' ? openPdf.url : null;
    const authors = Array.isArray(item.authors)
      ? (item.authors as Array<{ name?: unknown }>).map((a) => (typeof a.name === 'string' ? a.name : '')).filter(Boolean)
      : [];
    hits.push({
      source: 'semantic_scholar',
      externalId: arxivId ?? paperId,
      title: typeof item.title === 'string' ? item.title : '',
      authors,
      year: typeof item.year === 'number' ? item.year : null,
      venue: typeof item.venue === 'string' && item.venue ? item.venue : null,
      abstract: typeof item.abstract === 'string' && item.abstract ? item.abstract : null,
      url: typeof item.url === 'string' ? item.url : null,
      pdfUrl,
    });
  }
  return hits;
}

/** 标题归一化（小写、去空白与标点），用作去重键。 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function hitKey(h: PaperHit): string {
  // arXiv id 一律剥版本号（2401.12345v2 → 2401.12345），与 S2 的 externalIds.ArXiv 对齐。
  if (h.source === 'arxiv' || h.externalId.match(/^\d{4}\.\d{4,5}(v\d+)?$/)) {
    return `arxiv:${h.externalId.replace(/v\d+$/, '')}`;
  }
  return `title:${normalizeTitle(h.title)}`;
}

/** 合并去重：同一篇论文保留一条，缺字段用后到者补齐（并集语义）。 */
export function mergeHits(hits: PaperHit[]): PaperHit[] {
  const byKey = new Map<string, PaperHit>();
  for (const h of hits) {
    const key = hitKey(h);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, h);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...h,
      authors: h.authors.length ? h.authors : existing.authors,
      abstract: h.abstract ?? existing.abstract,
      venue: h.venue ?? existing.venue,
      url: h.url ?? existing.url,
      pdfUrl: h.pdfUrl ?? existing.pdfUrl,
    });
  }
  return [...byKey.values()];
}

async function arxivSearch(query: string, limit: number): Promise<PaperHit[]> {
  const url = new URL(ARXIV_API);
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(Math.min(limit, 20)));
  const res = await fetch(url, { headers: { Accept: 'application/atom+xml' } });
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  return parseArxivAtom(await res.text());
}

async function s2Search(query: string, limit: number): Promise<PaperHit[]> {
  const url = new URL(S2_API);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(Math.min(limit, 20)));
  url.searchParams.set(
    'fields',
    'title,abstract,year,venue,authors,externalIds,openAccessPdf,url',
  );
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Semantic Scholar HTTP ${res.status}`);
  return parseS2Json(await res.json());
}

/** 并发查两源；单源失败不影响另一源（Promise.allSettled），失败原因以 warnings 返回。 */
export async function search(query: string, limit = 10): Promise<{ hits: PaperHit[]; warnings: string[] }> {
  const [arxiv, s2] = await Promise.allSettled([arxivSearch(query, limit), s2Search(query, limit)]);
  const hits: PaperHit[] = [];
  const warnings: string[] = [];
  if (arxiv.status === 'fulfilled') hits.push(...arxiv.value);
  else warnings.push(`arXiv 检索失败：${reason(arxiv.reason)}`);
  if (s2.status === 'fulfilled') hits.push(...s2.value);
  else warnings.push(`Semantic Scholar 检索失败：${reason(s2.reason)}（可能被限流，已回退到 arXiv 结果）`);
  return { hits: mergeHits(hits), warnings };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 下载 PDF 到 dir/<safeName>.pdf；返回绝对路径。 */
export async function downloadPdf(pdfUrl: string, dir: string, safeName: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filePath = path.join(dir, safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** 从 URL 提取安全文件名（不含扩展名、非法字符），空则回退 'paper'。 */
export function safeFileNameFromUrl(url: string | null): string {
  if (!url) return 'paper';
  const last = url.split('/').filter(Boolean).pop() ?? '';
  const name = last.replace(/[^\w.\-]+/g, '_').replace(/\.pdf$/i, '');
  return name || 'paper';
}
