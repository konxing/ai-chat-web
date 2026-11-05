import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTCOME_FACET_ROWS, outcomeFacetRows } from '@/lib/cognitive/outcome-display';

/**
 * 结果四列的展示口径（5.3 的界面那一半）。
 *
 * 为什么抽成纯函数：面板在 node 环境里跑不起来（这套测试体系没有 jsdom），
 * 但「哪一列该出现、以什么顺序、标签怎么说」是可以脱离 JSX 验的。所以把这些判断
 * 全放进纯函数，界面上只留一句 map——静态断言盯的就是「界面没自己另发明一套规则」。
 *
 * 这里最重要的一条是 null 不出行：任务书要求派生不出来的列写 null，界面上如果给
 * null 也摆一行标签，用户看到的就是一行「有内容但没字」——那是「这句没说过」和
 * 「说了但空着」两种意思被抹成一样。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/decision-panel.tsx');
const PANEL_CODE = stripComments(PANEL);

describe('结果分面的行序与标签', () => {
  it('四个标签逐字钉住，顺序是库里读起来的顺序：预期差 → 漏掉 → 经验 → 评价', () => {
    expect(OUTCOME_FACET_ROWS.map((row) => row.label)).toEqual([
      '和当初预期的差别',
      '当时漏掉的因素',
      '总结出的经验',
      '现在的评价'
    ]);
    expect(OUTCOME_FACET_ROWS.map((row) => row.field)).toEqual([
      'gap',
      'missedFactors',
      'lesson',
      'rating'
    ]);
  });

  it('四列都有值 ⇒ 四行，每行是标签加那一段原话', () => {
    const rows = outcomeFacetRows({
      gap: '本来以为不用管备份',
      missedFactors: '没想到备份要自己写',
      lesson: '下次先看运维成本',
      rating: '还行'
    });
    expect(rows).toEqual([
      { label: '和当初预期的差别', text: '本来以为不用管备份' },
      { label: '当时漏掉的因素', text: '没想到备份要自己写' },
      { label: '总结出的经验', text: '下次先看运维成本' },
      { label: '现在的评价', text: '还行' }
    ]);
  });

  it('派生不出来的列不出行：界面不给「有内容但没字」的标签', () => {
    const rows = outcomeFacetRows({
      gap: '本来以为不用管备份',
      missedFactors: null,
      lesson: null,
      rating: null
    });
    expect(rows).toEqual([{ label: '和当初预期的差别', text: '本来以为不用管备份' }]);
  });

  it('一句只有整句原话、四列全空 ⇒ 一行都不摆', () => {
    expect(outcomeFacetRows({ gap: null, missedFactors: null, lesson: null, rating: null })).toEqual(
      []
    );
  });
});

describe('面板只做渲染，不自己另定规则', () => {
  it('结果展开区走 outcomeFacetRows，四个标签不在面板里各写一遍', () => {
    expect(PANEL).toContain('outcomeFacetRows');
    for (const label of OUTCOME_FACET_ROWS.map((row) => row.label)) {
      expect(PANEL_CODE).not.toContain(label);
    }
  });

  it('面板不直接读四个分面字段当行渲染（读一次 actual 除外）', () => {
    for (const field of ['gap', 'missedFactors', 'lesson', 'rating'] as const) {
      expect(PANEL_CODE).not.toContain(`{outcome.${field}}`);
    }
    expect(PANEL_CODE).toContain('{outcome.actual}');
  });

  it('结果原话的出处仍然写清楚：这行是原话，不是系统的结论', () => {
    expect(PANEL).toContain('AI 认为这句话可能是这条决策的结果，是否关联由你定。');
  });
});
