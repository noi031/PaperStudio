// db.ts 单测：schema 初始化、settings 读写往返。
import { describe, it, expect } from 'vitest';
import { openDb } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/types';

function makeDb() {
  return openDb(':memory:');
}

describe('Db', () => {
  it('初始化全部表', () => {
    const db = makeDb();
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of ['papers', 'notes', 'summaries', 'reviews', 'directions', 'drafts', 'presentations', 'settings', 'agent_sessions']) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('settings 默认值与保存往返', () => {
    const db = makeDb();
    const s0 = db.getSettings();
    expect(s0.username).toBe(DEFAULT_SETTINGS.username);
    expect(s0.llmBaseUrl).toBe('https://api.deepseek.com');
    const saved = db.saveSettings({ username: 'alice', llmModel: 'deepseek-chat' });
    expect(saved.username).toBe('alice');
    expect(saved.llmModel).toBe('deepseek-chat');
    expect(db.getSettings().username).toBe('alice');
    db.close();
  });

  it('settings 覆盖后未改动字段保留默认', () => {
    const db = makeDb();
    db.saveSettings({ llmApiKey: 'k' });
    const s = db.getSettings();
    expect(s.llmApiKey).toBe('k');
    expect(s.echoMemEnabled).toBe(false);
    db.close();
  });
});
