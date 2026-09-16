// Agentic 检索：用户自然语言提问 → LLM 生成检索查询词 → 走现有多源检索合并 →
// LLM 对结果批量评估相关度（高/中/低 + 一句理由）→ 返回可复用的结果列表。
import OpenAI from 'openai';
import type { PaperHit, PaperSettings } from '../shared/types.js';
import { search, normalizeTitle } from './searchService.js';

export interface AgenticRelevance {
  level: '高' | '中' | '低';
  reason: string;
}

export interface AgenticResult {
  hits: PaperHit[];
  queries: string[];
  relevance: Record<string, AgenticRelevance>;
  warnings: string[];
}

export type AgenticStage = 'plan' | 'searching' | 'scoring';

/** 从 LLM 输出里提取第一个 JSON 对象（容错 markdown 代码围栏与前后杂质）。 */
export function extractJson(text: string): string {
  const cleaned = text
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 输出不是有效 JSON');
  return cleaned.slice(start, end + 1);
}

/** 结果去重键：arXiv id 剥版本号 / OpenAlex W id / S2 paperId / 标题归一化。 */
function agenticKey(h: PaperHit): string {
  if (h.source === 'arxiv') return `arxiv:${h.externalId.replace(/v\d+$/, '')}`;
  if (h.source === 'openalex') return `openalex:${h.externalId}`;
  if (h.source === 'semantic_scholar') return `s2:${h.externalId}`;
  return `title:${normalizeTitle(h.title)}`;
}

/**
 * Agentic 检索主流程。
 * @param emitStage 阶段回调（UI 进度提示：plan → searching → scoring）
 */
export async function agenticSearch(
  question: string,
  settings: PaperSettings,
  emitStage?: (stage: AgenticStage) => void,
): Promise<AgenticResult> {
  const { llmBaseUrl, llmApiKey, llmModel } = settings;
  if (!llmApiKey) throw new Error('未配置 LLM API Key，请到设置页填写');
  const client = new OpenAI({ baseURL: llmBaseUrl || undefined, apiKey: llmApiKey });

  // 1) 把自然语言问题转化为 2-4 个英文检索查询
  emitStage?.('plan');
  const plan = await client.chat.completions.create({
    model: llmModel,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content:
          '你是学术论文检索规划助手。用户会用自然语言提出一个研究问题，请把它转化为 2-4 个适合学术论文数据库（arXiv / Semantic Scholar / OpenAlex 全文检索）的关键词查询。' +
          '要求：英文；每个查询是 2-6 个关键词组合（覆盖问题的不同侧面）；不输出任何解释。' +
          '只输出 JSON：{"queries":["query one","query two"]}',
      },
      { role: 'user', content: question },
    ],
  });
  let queries: string[] = [];
  try {
    const planText = extractJson(plan.choices[0]?.message?.content ?? '');
    queries = (JSON.parse(planText).queries as unknown[] ?? []).map(String).slice(0, 4);
  } catch (err) {
    throw new Error(`AI 未能生成有效的检索查询：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!queries.length) throw new Error('AI 未能生成有效的检索查询');

  // 2) 逐查询走现有多源检索，合并去重
  emitStage?.('searching');
  const hitsMap = new Map<string, PaperHit>();
  const warnings = new Set<string>();
  for (const q of queries) {
    const res = await search(q, 5, { s2ApiKey: settings.semanticScholarApiKey });
    for (const h of res.hits) {
      const k = agenticKey(h);
      // 同一篇论文保留字段更全的一条
      const cur = hitsMap.get(k);
      if (!cur || (cur.abstract ?? '')!.length < (h.abstract ?? '').length) hitsMap.set(k, h);
    }
    for (const w of res.warnings) warnings.add(w);
  }
  const hits = [...hitsMap.values()].slice(0, 15);
  if (!hits.length) return { hits: [], queries, relevance: {}, warnings: [...warnings] };

  // 3) 批量评估每条结果与问题的相关度
  emitStage?.('scoring');
  const scored = await scoreRelevance(client, llmModel, question, hits);
  return { hits, queries, relevance: scored, warnings: [...warnings] };
}

/** 批量相关度评估：标题+摘要给 LLM，返回 index → 相关度。单次调用覆盖全部结果。 */
async function scoreRelevance(
  client: OpenAI,
  model: string,
  question: string,
  hits: PaperHit[],
): Promise<Record<string, AgenticRelevance>> {
  const list = hits
    .map(
      (h, i) =>
        `${i}. 标题：${h.title}\n摘要：${(h.abstract ?? '').slice(0, 300)}${h.abstract && h.abstract.length > 300 ? '…' : ''}`,
    )
    .join('\n\n');
  const res = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    messages: [
      {
        role: 'system',
        content:
          '你是论文相关性评估助手。用户给出一条研究问题，以及若干条检索结果的标题和摘要。' +
          '请判断每条结果与问题的相关程度，level 只能取「高」「中」「低」，reason 用一句中文说明该论文为什么相关（或为什么不太相关）。' +
          '只输出 JSON：{"results":[{"index":0,"level":"高","reason":"..."}]}，必须覆盖全部条目。',
      },
      { role: 'user', content: `研究问题：${question}\n\n检索结果：\n${list}` },
    ],
  });
  const out: Record<string, AgenticRelevance> = {};
  try {
    const text = extractJson(res.choices[0]?.message?.content ?? '');
    const parsed = JSON.parse(text) as { results?: Array<{ index?: unknown; level?: unknown; reason?: unknown }> };
    for (const r of parsed.results ?? []) {
      const idx = Number(r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= hits.length) continue;
      const level = r.level === '高' || r.level === '中' ? r.level : r.level === '低' ? '低' : '中';
      const reason = String(r.reason ?? '').trim() || '（模型未给出说明）';
      out[agenticKey(hits[idx])] = { level, reason };
    }
  } catch {
    // 评估失败不影响结果列表（无相关度标注）
  }
  return out;
}
