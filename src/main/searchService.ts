// P3 检索服务：arXiv + Semantic Scholar 并发检索、解析、合并去重、PDF 下载。
// 纯函数（parseArxivAtom/parseS2Json/mergeHits）独立导出供单测；网络入口 search/downloadPdf。
import fs from 'node:fs';
import path from 'node:path';
import type { PaperHit } from '../shared/types.js';

// 主进程 fetch 用 Electron 网络栈（net.fetch）：它走系统代理（与浏览器一致），
// 而 Node 原生 fetch 是直连——直连出口 IP 常被 arXiv/S2 API 限流（429），
// 浏览器却能访问。jest/node 环境无 electron 时回退到原生 fetch。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronNet: { fetch: typeof fetch } | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron').net ?? null;
  } catch {
    return null;
  }
})();
export function httpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return electronNet && typeof electronNet.fetch === 'function' ? electronNet.fetch(url, init) : fetch(url, init);
}

const ARXIV_API = 'https://export.arxiv.org/api/query';
const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
// arXiv API 要求请求携带标识性 User-Agent，否则极易触发 429/403 限流。
const UA = 'PaperStudio/1.0 (https://github.com/noi031/PaperStudio)';
// arXiv 网页搜索需要浏览器 UA（反爬标识）。
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// arXiv 官方要求相邻请求间隔 ≥3 秒；连续搜索时排队等待，避免 429。
let lastArxivAt = 0;
// 检索结果缓存（10 分钟），减少重复请求触发限流。
const cache = new Map<string, { at: number; hits: PaperHit[]; warnings: string[] }>();
const CACHE_TTL = 10 * 60 * 1000;

/** 解析 arXiv 搜索页 HTML（.arxiv-result 块）→ PaperHit[]。网页端点不受 API 限流影响。 */
export function parseArxivSearchHtml(html: string): PaperHit[] {
  const hits: PaperHit[] = [];
  for (const m of html.matchAll(/<li class="arxiv-result">([\s\S]*?)<\/li>/g)) {
    const block = m[1];
    const idM = block.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
    if (!idM) continue;
    const id = idM[1].replace(/v\d+$/, '');
    const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const title = (block.match(/<p class="title is-5 mathjax">([\s\S]*?)<\/p>/) ?? [])[1] ? strip((block.match(/<p class="title is-5 mathjax">([\s\S]*?)<\/p>/) ?? [])[1]) : '';
    const authors = [...block.matchAll(/<a href="\/search\/\?searchtype=author[^>]*>([\s\S]*?)<\/a>/g)].map((a) => strip(a[1])).filter(Boolean);
    const abstract = (block.match(/<span class="abstract-short[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1]
      ? ((block.match(/<span class="abstract-short[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] as string)
          .replace(/<[^>]+>/g, '')
          .replace(/&hellip;.*$/s, '')
          .replace(/&[a-z]+;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
    // arXiv id 前 4 位是 YYMM（旧 id 为 math/YYMM）。
    const yymm = id.match(/^\d{4}\./) ? id.slice(0, 4) : (id.match(/^[a-z-]+\/(\d{4})/) ?? [])[1] ?? '';
    const year = yymm ? 2000 + Number(yymm.slice(0, 2)) || null : null;
    if (!title) continue;
    hits.push({
      source: 'arxiv',
      externalId: id,
      title,
      authors,
      year,
      venue: null,
      abstract: abstract || null,
      url: `https://arxiv.org/abs/${id}`,
      pdfUrl: `https://arxiv.org/pdf/${id}`,
    });
  }
  return hits;
}

async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  opts: { label: string; maxRetries?: number; retryable?: (status: number) => boolean },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 2;
  const retryable = opts.retryable ?? ((s: number) => s === 429 || s >= 500);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await httpFetch(url, init);
    if (!retryable(res.status)) return res;
    lastErr = new Error(`${opts.label} HTTP ${res.status}`);
    const ra = Number(res.headers.get('retry-after') ?? '0');
    const waitMs = Math.max(ra * 1000, 3000) * (attempt + 1);
    // eslint-disable-next-line no-console
    console.log(`[search] ${opts.label} HTTP ${res.status}，${Math.round(waitMs / 1000)}s 后重试（第 ${attempt + 1} 次）`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw lastErr ?? new Error(`${opts.label} 失败`);
}

/** arXiv 最小请求间隔 3 秒（官方要求），不足则等待。 */
async function throttleArxiv(): Promise<void> {
  const now = Date.now();
  const wait = 3000 - (now - lastArxivAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastArxivAt = Date.now();
}

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

async function arxivSearch(query: string, limit: number, offset = 0): Promise<PaperHit[]> {
  await throttleArxiv();
  const url = new URL(ARXIV_API);
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', String(offset));
  url.searchParams.set('max_results', String(Math.min(limit, 20)));
  // API 429 是 IP 级限流（1 小时窗口），重试无意义——只试一次，任何失败立即回退网页搜索。
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/atom+xml', 'User-Agent': UA } }, { label: 'arXiv', maxRetries: 0 });
    if (res.ok) return parseArxivAtom(await res.text());
    // eslint-disable-next-line no-console
    console.log(`[search] arXiv API HTTP ${res.status}，回退网页搜索`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[search] arXiv API 失败（${err instanceof Error ? err.message : String(err)}），回退网页搜索`);
  }
  return arxivSearchWeb(query, limit, offset);
}

/** arXiv 网页搜索（API 429 限流时的回退通道）。 */
async function arxivSearchWeb(query: string, limit: number, offset = 0): Promise<PaperHit[]> {
  await throttleArxiv();
  const url = new URL('https://arxiv.org/search/');
  url.searchParams.set('query', query);
  url.searchParams.set('searchtype', 'all');
  url.searchParams.set('start', String(offset));
  const res = await httpFetch(url, { headers: { Accept: 'text/html', 'User-Agent': UA_BROWSER } });
  if (!res.ok) throw new Error(`arXiv 网页搜索 HTTP ${res.status}`);
  return parseArxivSearchHtml(await res.text()).slice(0, Math.min(limit, 20));
}

async function s2Search(query: string, limit: number, apiKey?: string, offset = 0): Promise<PaperHit[]> {
  const url = new URL(S2_API);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(Math.min(limit, 20)));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set(
    'fields',
    'title,abstract,year,venue,authors,externalIds,openAccessPdf,url',
  );
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA };
  if (apiKey) headers['x-api-key'] = apiKey;
  // S2 无 key 限流极严（429 常态）；限流时回退 OpenAlex（免费开放、不限流）。
  try {
    const res = await fetchWithRetry(
      url,
      { headers },
      { label: 'Semantic Scholar', maxRetries: 0 },
    );
    if (res.ok) return parseS2Json(await res.json());
    // eslint-disable-next-line no-console
    console.log(`[search] Semantic Scholar HTTP ${res.status}，回退 OpenAlex`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[search] Semantic Scholar 失败（${err instanceof Error ? err.message : String(err)}），回退 OpenAlex`);
  }
  return openAlexSearch(query, limit, offset);
}

/** 解析 OpenAlex /works 响应 JSON → PaperHit[]。abstract 为倒排索引需重建。 */
export function parseOpenAlexJson(json: unknown): PaperHit[] {
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: PaperHit[] = [];
  for (const item of results as Array<Record<string, unknown>>) {
    const id = typeof item.id === 'string' ? item.id.replace(/^https?:\/\/openalex\.org\//, '') : '';
    const title = typeof item.title === 'string' && item.title ? item.title.trim() : '';
    if (!id || !title) continue;
    const authors = Array.isArray(item.authorships)
      ? (item.authorships as Array<{ author?: { display_name?: unknown } }>)
          .map((a) => (typeof a.author?.display_name === 'string' ? a.author.display_name : ''))
          .filter(Boolean)
      : [];
    const venue = (item.primary_location as { source?: { display_name?: unknown } } | null)?.source?.display_name;
    // abstract_inverted_index: { word: [pos,...] } → 按位置拼接。
    const inv = item.abstract_inverted_index as Record<string, number[]> | null;
    let abstract = '';
    if (inv && typeof inv === 'object') {
      const words: Array<{ w: string; p: number }> = [];
      for (const [w, ps] of Object.entries(inv)) for (const p of ps) words.push({ w, p });
      words.sort((a, b) => a.p - b.p);
      abstract = words.map((x) => x.w).join(' ').slice(0, 2000);
    }
    hits.push({
      source: 'openalex',
      externalId: id,
      title,
      authors,
      year: typeof item.publication_year === 'number' ? item.publication_year : null,
      venue: typeof venue === 'string' && venue ? venue : null,
      abstract: abstract || null,
      url: typeof item.doi === 'string' ? `https://doi.org/${item.doi.replace(/^https?:\/\/doi\.org\//, '')}` : null,
      pdfUrl: null,
    });
  }
  return hits;
}

/** OpenAlex 检索（S2 429 限流时的回退通道；免费开放、无需 key）。 */
async function openAlexSearch(query: string, limit: number, offset = 0): Promise<PaperHit[]> {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(Math.min(limit, 20)));
  if (offset > 0) url.searchParams.set('offset', String(Math.min(offset, 10000)));
  url.searchParams.set('mailto', 'paperstudio@localhost');
  const res = await httpFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  return parseOpenAlexJson(await res.json());
}

/** 把网络错误翻译成对用户友好的中文提示（429 限流最常见）。 */
function friendly(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes('HTTP 429')) {
    return `${m}：检索接口限流，请稍等片刻再试（通常 1 小时后自动解除）；若经常出现，可在设置页配置 Semantic Scholar API Key 或更换网络/代理节点`;
  }
  return m;
}

/** 并发查两源；单源失败不影响另一源（Promise.allSettled），失败原因以 warnings 返回。
 *  成功结果按查询+页缓存 10 分钟，减少重复请求触发限流。offset 用于分页（每页 limit 条）。 */
export async function search(
  query: string,
  limit = 10,
  opts: { s2ApiKey?: string } = {},
  offset = 0,
): Promise<{ hits: PaperHit[]; warnings: string[] }> {
  const key = `${query.trim().toLowerCase()}|${limit}|${offset}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return { hits: cached.hits, warnings: cached.warnings };
  const [arxiv, s2] = await Promise.allSettled([
    arxivSearch(query, limit, offset),
    s2Search(query, limit, opts.s2ApiKey, offset),
  ]);
  const hits: PaperHit[] = [];
  const warnings: string[] = [];
  if (arxiv.status === 'fulfilled') hits.push(...arxiv.value);
  else warnings.push(`arXiv 检索失败：${friendly(arxiv.reason)}`);
  if (s2.status === 'fulfilled') hits.push(...s2.value);
  else warnings.push(`Semantic Scholar 检索失败：${friendly(s2.reason)}`);
  const result = { hits: mergeHits(hits), warnings };
  if (result.hits.length > 0) cache.set(key, { at: Date.now(), ...result });
  return result;
}

/** 下载 PDF 到 dir/<safeName>.pdf；返回绝对路径。 */
export async function downloadPdf(pdfUrl: string, dir: string, safeName: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetchWithRetry(pdfUrl, { headers: { 'User-Agent': UA } }, { label: 'PDF', maxRetries: 2 });
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
