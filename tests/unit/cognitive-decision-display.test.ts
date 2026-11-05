import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECISION_DETAIL_ROWS, decisionDetailRows } from '@/lib/cognitive/decision-display';

/**
 * 决策两列的展示口径（任务书 5.2 的「预期结果」与「可选的后续复盘时间」）。
 *
 * 和结果四列同一个理由抽成纯函数：这套测试没有 jsdom，面板跑不起来，
 * 但「哪一列该出现、标签怎么说、日期长什么样」脱离 JSX 也验得了。
 *
 * null 不出行这条在这里更要紧：这两列在库里的默认值就是 null——用户没说过预期、
 * 没安排复盘。给它摆一行空标签，等于把「这句没说过」显示成「说了但空着」，
 * 而这一屏下一步要请用户确认的就是「我到底说过什么」。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL_CODE = stripComments(read('src/components/settings/decision-panel.tsx'));
const DISPLAY_CODE = read('src/lib/cognitive/decision-display.ts');

describe('决策两列的行序与标签', () => {
  it('两个标签逐字钉住，顺序是先说期待、再说什么时候回头看', () => {
    expect(DECISION_DETAIL_ROWS.map((row) => row.field)).toEqual(['expectedOutcome', 'reviewAfter']);
    expect(DECISION_DETAIL_ROWS.map((row) => row.label)).toEqual(['当初的预期', '计划复盘']);
  });

  it('两列都有值 ⇒ 两行，复盘那一套日期用全项目统一的「年月日」', () => {
    const rows = decisionDetailRows({
      expectedOutcome: '预计查询能快一倍',
      reviewAfter: '2027-02-04T04:00:00.000Z'
    });
    expect(rows).toEqual([
      { label: '当初的预期', text: '预计查询能快一倍' },
      { label: '计划复盘', text: '2027年2月4日' }
    ]);
  });

  it('用户没说过的列不出行：只有预期、或只有安排，都只摆写得出那一列的一行', () => {
    expect(decisionDetailRows({ expectedOutcome: '预计能省一半时间', reviewAfter: null })).toEqual([
      { label: '当初的预期', text: '预计能省一半时间' }
    ]);
    expect(decisionDetailRows({ expectedOutcome: null, reviewAfter: '2026-12-06T04:00:00.000Z' })).toEqual([
      { label: '计划复盘', text: '2026年12月6日' }
    ]);
  });

  it('两列都是 null ⇒ 一行都不摆，不给「时间未知」这种占位', () => {
    expect(decisionDetailRows({ expectedOutcome: null, reviewAfter: null })).toEqual([]);
  });
});

describe('面板只做渲染，不自己另定规则', () => {
  it('两行都走 decisionDetailRows，标签不在面板里再写一遍', () => {
    expect(PANEL_CODE).toContain('decisionDetailRows');
    for (const label of DECISION_DETAIL_ROWS.map((row) => row.label)) {
      expect(PANEL_CODE).not.toContain(label);
    }
  });

  it('面板不直接把这两列当文本渲染出去', () => {
    expect(PANEL_CODE).not.toContain('{decision.expectedOutcome}');
    expect(PANEL_CODE).not.toContain('{decision.reviewAfter}');
  });

  it('日期口径复用记忆那一屏的 formatDate，第三套「年月日」不许出现', () => {
    expect(DISPLAY_CODE).toContain("from './memory-display'");
    expect(DISPLAY_CODE).not.toMatch(/getUTCMonth\(\)\s*\+\s*1/);
  });
});
