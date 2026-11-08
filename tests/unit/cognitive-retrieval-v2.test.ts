import { describe, expect, it } from 'vitest';
import { rankMemoriesWithEvidence } from '@/lib/cognitive/retrieval';

const doc = (id: string, content: string, vector?: Float32Array) => ({
  id,
  content,
  vector,
  recordedAt: id === 'new' ? '2026-11-07T00:00:00.000Z' : '2026-10-01T00:00:00.000Z'
});

describe('strict evidence-gated retrieval (opt-in v2)', () => {
  it('unrelated recent memories are never injected as filler', () => {
    const rows = [doc('new', '今天天气不错'), doc('old', '我正在学习数学一')];
    expect(rankMemoriesWithEvidence('zzz qqq', rows, { limit: 8 })).toEqual([]);
  });

  it('relevant older memories win over newer unrelated entries', () => {
    const rows = [doc('new', '今天去买菜'), doc('old', '我正在学习数学一')];
    expect(rankMemoriesWithEvidence('数学一复习进度', rows, { limit: 8 }).map((x) => x.id)).toEqual(['old']);
  });

  it('semantic similarity can recover memories with no lexical overlap', () => {
    const rows = [
      doc('new', '今天去买菜', new Float32Array([0, 1])),
      doc('old', '我在研究跳槽机会', new Float32Array([1, 0]))
    ];
    expect(rankMemoriesWithEvidence('转职', rows, {
      queryVector: new Float32Array([1, 0]),
      limit: 8
    }).map((x) => x.id)).toEqual(['old']);
  });

  it('incompatible vectors cannot manufacture a semantic hit', () => {
    const rows = [doc('old', '我在研究跳槽机会', new Float32Array([1, 0, 0]))];
    expect(rankMemoriesWithEvidence('转职', rows, {
      queryVector: new Float32Array([1, 0]), limit: 8
    })).toEqual([]);
  });

  it('preserves the caller array and respects the limit', () => {
    const rows = [doc('new', '我正在学数学一'), doc('old', '数学一模拟考试')];
    const original = [...rows];
    expect(rankMemoriesWithEvidence('数学一', rows, { limit: 1 })).toHaveLength(1);
    expect(rows).toEqual(original);
  });
});
