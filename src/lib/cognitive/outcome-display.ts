import type { OutcomeFacet } from './outcome-extractor';

/**
 * 结果四列的展示口径（任务书 5.3 的界面那一半）。
 *
 * 这四列是「同一句原话按说法归到四列」的产物，所以界面不重排、不概括、不合并成一句结论——
 * 归错了列由用户在原句上自己判。界面上把标签和那一段原话并排放着，才对得上库里的列。
 *
 * null 不出行是这片的核心：派生不出来的列在库里就是 null，界面上给它摆一行标签，
 * 等于把「这句没说过」显示成「说了但空着」。
 *
 * 测试：tests/unit/cognitive-outcome-display.test.ts
 */
export const OUTCOME_FACET_ROWS: ReadonlyArray<{ field: OutcomeFacet; label: string }> = [
  { field: 'gap', label: '和当初预期的差别' },
  { field: 'missedFactors', label: '当时漏掉的因素' },
  { field: 'lesson', label: '总结出的经验' },
  { field: 'rating', label: '现在的评价' }
];

export function outcomeFacetRows(
  outcome: Record<OutcomeFacet, string | null>
): Array<{ label: string; text: string }> {
  return OUTCOME_FACET_ROWS.flatMap(({ field, label }) => {
    const text = outcome[field];
    return text === null ? [] : [{ label, text }];
  });
}
