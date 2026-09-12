// paperRepo.ts 单测：papers 表 CRUD、按来源查重、pdf_path 更新。
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db';
import { PaperRepo } from '../paperRepo';
import type { PaperHit } from '../../shared/types';

const HIT: PaperHit = {
  source: 'arxiv',
  externalId: '2401.12345',
  title: 'A Great Paper',
  authors: ['Alice Chen'],
  year: 2024,
  venue: null,
  abstract: 'Abstract here',
  url: 'https://arxiv.org/abs/2401.12345',
  pdfUrl: 'https://arxiv.org/pdf/2401.12345',
};

function makeRepo() {
  const db = openDb(':memory:');
  return { repo: new PaperRepo(db.raw), db };
}

describe('PaperRepo', () => {
  let ctx: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    ctx = makeRepo();
  });

  it('save 入库并可 list/get', () => {
    const r = ctx.repo.save(HIT);
    expect(r.id).toBeTruthy();
    expect(r.source).toBe('arxiv');
    expect(r.externalId).toBe('2401.12345');
    expect(r.pdfUrl).toBe('https://arxiv.org/pdf/2401.12345');
    expect(r.pdfPath).toBeNull();

    const list = ctx.repo.list();
    expect(list).toHaveLength(1);
    expect(ctx.repo.get(r.id)?.title).toBe('A Great Paper');
  });

  it('同源同 external_id 重复 save 更新不新增', () => {
    ctx.repo.save(HIT);
    const again = ctx.repo.save({ ...HIT, title: 'Renamed', venue: 'ACL' });
    expect(again.title).toBe('Renamed');
    expect(again.venue).toBe('ACL');
    expect(ctx.repo.list()).toHaveLength(1);
  });

  it('不同来源同 external_id 各自入库', () => {
    ctx.repo.save(HIT);
    ctx.repo.save({ ...HIT, source: 'semantic_scholar' });
    expect(ctx.repo.list()).toHaveLength(2);
  });

  it('setPdfPath / remove', () => {
    const r = ctx.repo.save(HIT);
    ctx.repo.setPdfPath(r.id, 'C:\\papers\\x.pdf');
    expect(ctx.repo.get(r.id)?.pdfPath).toBe('C:\\papers\\x.pdf');
    ctx.repo.remove(r.id);
    expect(ctx.repo.get(r.id)).toBeNull();
  });
});
