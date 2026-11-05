import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDecisionCandidates } from '@/lib/cognitive/decision-extractor';
import {
  DECISION_EMPTY_STATE_DESCRIPTION,
  DECISION_INTAKE_EXAMPLES
} from '@/lib/cognitive/decision-display';

/**
 * 决策屏空态那句话的诚实性（任务书 5.5 的界面那一半）。
 *
 * 面板原本写的是「你在对话里说「我决定……」时，这里会出现待确认的候选」。
 * 这句话单看没问题，对着 v1 的词表看就是空头承诺：光「我决定」抽不出候选，
 * 要「我决定用 / 我改用」这一类硬短语才行——那条边界是实测出来的，
 * 记在验收文档片P-3 第八节。
 *
 * 为什么值得单独钉：空态是用户和这一屏的第一次接触。它说错了，用户就会以为自己说了却没被记下来，
 * 于是他开始把「系统没记」理解成「我表达得不好」——而这一层的立身之本恰恰是
 * 「AI 不能替用户宣布他说过什么」，也不该替用户宣布他该怎么说。
 *
 * 所以这句话现在从举例清单拼出来，而举例清单由真实抽取器验：
 * 验的是「照着这句话说的确会出候选」这个行为，不是两处字符串一致。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL_CODE = stripComments(read('src/components/settings/decision-panel.tsx'));
const DISPLAY_CODE = stripComments(read('src/lib/cognitive/decision-display.ts'));

describe('空态那句话不得承诺抽取器做不到的事', () => {
  it('举的每一个说法都真能产出候选：跑的是抽取器本身，不是字符串对照', () => {
    expect(DECISION_INTAKE_EXAMPLES.length).toBeGreaterThan(0);
    for (const example of DECISION_INTAKE_EXAMPLES) {
      expect(extractDecisionCandidates(`${example} PostgreSQL。`)).toHaveLength(1);
    }
  });

  it('「我决定」这一类动词本身不算例子：它在动词表里，却抽不出候选', () => {
    expect(extractDecisionCandidates('我决定 PostgreSQL。')).toHaveLength(0);
    expect(DECISION_INTAKE_EXAMPLES).not.toContain('我决定');
  });

  it('这句话由展示模块从举例清单拼出来，面板不自己另写一份', () => {
    expect(DECISION_EMPTY_STATE_DESCRIPTION).toContain('你在对话里说');
    expect(DISPLAY_CODE).toContain('DECISION_INTAKE_EXAMPLES.map');
    expect(PANEL_CODE).toContain('DECISION_EMPTY_STATE_DESCRIPTION');
    expect(PANEL_CODE).not.toContain('你在对话里说');
  });
});
