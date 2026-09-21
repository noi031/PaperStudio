import { describe, it, expect } from 'vitest';
import { buildQaMessages } from '../qaService.js';

describe('qaService 提示词组装', () => {
  it('不带批注：普通问答提示词，不含批注相关内容', () => {
    const msgs = buildQaMessages('A Paper', '高亮段落原文', '这篇论文的方法是什么？');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('论文阅读问答助手');
    expect(msgs[0].content).not.toContain('批注');
    expect(msgs[1].content).toContain('论文标题：A Paper');
    expect(msgs[1].content).toContain('高亮段落原文');
    expect(msgs[1].content).toContain('问题：这篇论文的方法是什么？');
    expect(msgs[1].content).not.toContain('我的批注');
  });

  it('带批注：要求 AI 先判断批注是否准确、指出问题、给出改进后的批注，再回答问题', () => {
    const msgs = buildQaMessages('A Paper', '高亮段落原文', '请判断我的批注是否准确，并给出改进意见。', '我的理解：这里用的是对比学习');
    expect(msgs[0].content).toContain('判断该批注是否准确');
    expect(msgs[0].content).toContain('准确／部分准确／不准确');
    expect(msgs[0].content).toContain('改进后的批注');
    expect(msgs[1].content).toContain('我的批注：\n我的理解：这里用的是对比学习');
    // 批注在问题之前，高亮原文在两者之前
    const user = msgs[1].content;
    expect(user.indexOf('高亮段落原文')).toBeLessThan(user.indexOf('我的批注'));
    expect(user.indexOf('我的批注')).toBeLessThan(user.indexOf('问题：'));
  });

  it('批注为空白：等同于不带批注', () => {
    const msgs = buildQaMessages('A Paper', 'text', 'q', '   ');
    expect(msgs[0].content).not.toContain('批注');
    expect(msgs[1].content).not.toContain('我的批注');
  });
});