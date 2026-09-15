// P5 方向建议服务：基于文献库论文生成研究方向（直连 LLM，非流式 JSON）。
import type { PaperSettings, PaperRecord, DirectionSuggestion } from '../shared/types.js';
import { chatJson } from './llm.js';

/** 内置默认提示词（设置页可覆盖）。 */
export const DEFAULT_DIRECTIONS_SYSTEM =
  '你是研究方向规划专家。基于用户给出的论文列表，提出 3-5 个有前景、可落地的研究方向。' +
  '每个方向包含：title（简短标题）、description（1-3 句说明：为什么值得做、切入角度）、nextSteps（2-4 条具体下一步）。' +
  '输出 JSON：{"suggestions":[{"title":"...","description":"...","nextSteps":["...","..."]}]}。' +
  '数学公式一律用纯文本表达（如 γ、x²、B±→D），禁止使用任何 LaTeX 记号。';

/** 组装消息（纯函数，供单测）。system 为空时用内置默认。 */
export function buildDirectionMessages(
  papers: PaperRecord[],
  system?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const lines = papers.map((p, i) => {
    const abs = (p.abstract ?? '').replace(/\s+/g, ' ').slice(0, 400);
    return `${i + 1}. ${p.title}（${p.year ?? '年份未知'}${p.venue ? `, ${p.venue}` : ''}）\n   摘要：${abs || '（无）'}`;
  });
  const user = `以下是文献库中的 ${papers.length} 篇论文：\n\n${lines.join('\n\n')}\n\n请基于这些论文提出研究方向。`;
  return [
    { role: 'system', content: system?.trim() || DEFAULT_DIRECTIONS_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 生成方向建议：返回 suggestions 数组；无可用论文时抛出提示。 */
export async function generateDirections(
  getSettings: () => PaperSettings,
  papers: PaperRecord[],
): Promise<DirectionSuggestion[]> {
  if (papers.length === 0) throw new Error('请先选择至少一篇论文（文献库为空或未勾选）');
  const settings = getSettings();
  const data = await chatJson<{ suggestions?: DirectionSuggestion[] }>(
    settings,
    buildDirectionMessages(papers, settings.promptDirections),
  );
  const suggestions = (data.suggestions ?? []).map((s) => ({
    title: String(s.title ?? '').trim(),
    description: String(s.description ?? '').trim(),
    nextSteps: Array.isArray(s.nextSteps) ? s.nextSteps.map((n) => String(n).trim()).filter(Boolean) : [],
  }));
  if (suggestions.length === 0) throw new Error('LLM 未返回有效方向建议');
  return suggestions;
}
