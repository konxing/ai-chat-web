import { describe, expect, it } from 'vitest';
import { selectRelevantProfileEntries } from '@/lib/cognitive/profile-selection';

const entry = (id: string, content: string, confirmedAt = '2026-11-01T00:00:00.000Z') => ({
  id, content, confirmedAt, editedAt: null, sourceMemoryIds: [], sourceReflectionIds: []
});

describe('confirmed profile contextual selection', () => {
  it('older relevant profile outranks newer unrelated information', () => {
    const rows = [
      entry('new', '我喜欢喝绿茶', '2026-11-07T00:00:00.000Z'),
      entry('old', '我的考研科目是数学一与计算机408')
    ];
    expect(selectRelevantProfileEntries('数学一复习安排', rows, 1)[0]?.id).toBe('old');
  });

  it('does not fill all six slots with irrelevant profile rows', () => {
    const rows = Array.from({ length: 10 }, (_, index) => entry(String(index), '我喜欢喝绿茶'));
    expect(selectRelevantProfileEntries('编译器优化', rows, 6).length).toBeLessThanOrEqual(2);
  });

  it('keeps input data unchanged', () => {
    const rows = [entry('a', '我正在学数学一'), entry('b', '数学一考研学习计划')];
    const snapshot = [...rows];
    expect(selectRelevantProfileEntries('数学一', rows, 1)).toHaveLength(1);
    expect(rows).toEqual(snapshot);
  });
});
