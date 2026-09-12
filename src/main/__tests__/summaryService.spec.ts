// summaryService.ts 单测：prompt 组装（kind 分流、超长截断）。
import { describe, it, expect } from 'vitest';
import { buildSummaryMessages, MAX_INPUT_CHARS } from '../summaryService';

describe('buildSummaryMessages', () => {
  it('selected 走精读解释提示', () => {
    const msgs = buildSummaryMessages('T', 'selected', 'hello');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('选中');
    expect(msgs[1].content).toContain('论文标题：T');
    expect(msgs[1].content).toContain('hello');
  });

  it('full 走四部分结构化提示', () => {
    const msgs = buildSummaryMessages('T', 'full', 'text');
    expect(msgs[0].content).toContain('背景');
    expect(msgs[0].content).toContain('方法');
    expect(msgs[0].content).toContain('结果');
    expect(msgs[0].content).toContain('贡献');
  });

  it('超长输入截断并标注', () => {
    const long = 'x'.repeat(MAX_INPUT_CHARS + 1000);
    const msgs = buildSummaryMessages('T', 'full', long);
    expect(msgs[1].content.length).toBeLessThanOrEqual(MAX_INPUT_CHARS + 30);
    expect(msgs[1].content).toContain('已截断');
  });
});
