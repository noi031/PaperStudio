// backend.ts 后端解析单测：环境变量 > 设置项 > 自动探测（EchoCap 可用性）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PaperSettings } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';

const cap = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock('../echoCap.js', () => ({
  echoCapStatus: cap.status,
}));

import { resolveBackend, backendLabel, BACKEND_ENV } from '../backend';

function settings(over: Partial<PaperSettings> = {}): () => PaperSettings {
  return () => ({ ...DEFAULT_SETTINGS, ...over });
}

describe('resolveBackend 解析优先级', () => {
  const envKey = BACKEND_ENV;

  beforeEach(() => {
    cap.status.mockReturnValue({ ok: true });
  });

  afterEach(() => {
    delete process.env[envKey];
  });

  it('环境变量 PAPERSTUDIO_BACKEND=dsh 强制 dsh（即使 EchoCap 可用）', () => {
    process.env[envKey] = 'dsh';
    cap.status.mockReturnValue({ ok: true });
    expect(resolveBackend(settings({ aiBackend: 'echocap' }))).toBe('dsh');
  });

  it('环境变量 PAPERSTUDIO_BACKEND=echocap 强制 echocap（即使设置/探测均为 dsh）', () => {
    process.env[envKey] = 'echocap';
    cap.status.mockReturnValue({ ok: false });
    expect(resolveBackend(settings({ aiBackend: 'dsh' }))).toBe('echocap');
  });

  it('无环境变量时设置项 aiBackend 生效', () => {
    expect(resolveBackend(settings({ aiBackend: 'dsh' }))).toBe('dsh');
    expect(resolveBackend(settings({ aiBackend: 'echocap' }))).toBe('echocap');
  });

  it('自动探测：EchoCap 可用 → echocap；不可用 → dsh', () => {
    cap.status.mockReturnValue({ ok: true });
    expect(resolveBackend(settings())).toBe('echocap');
    cap.status.mockReturnValue({ ok: false, message: 'socket 缺失' });
    expect(resolveBackend(settings())).toBe('dsh');
  });

  it('环境变量大小写与空白被容忍', () => {
    process.env[envKey] = ' EchoCap ';
    expect(resolveBackend(settings())).toBe('echocap');
  });
});

describe('backendLabel', () => {
  it('返回人类可读标签', () => {
    expect(backendLabel('dsh')).toBe('dsh 引擎');
    expect(backendLabel('echocap')).toBe('EchoCap 代理');
  });
});
