import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「记忆」那一屏的静态断言（任务书 7.2 的 ARCHIVE + 两份列表的截断提示）。
 *
 * 为什么不跑用例：vitest 跑在 node 环境，这套测试体系里没有 jsdom 和渲染器，JSX 里的 div 和
 * onClick 根本没法运行。所以这一屏能验的两件事都按 `cognitive-reflection-panel.test.ts` 那套读源码的方式验：
 * 一、**批准的文案不许被悄悄改掉**——11-05 那两张逐字表（归档展开区、已归档区块、头部那句说明）
 *    是他过目后定下来的句子，改一个标点就等于改了用户看到的句子；
 * 二、**不许出现没有消费者的控件**——归档和恢复各要真的打到自己的路由，截断提示各要真的挂上自己那份列表。
 *
 * 界面本身（像素、点击、真实数据下的排布）**不在这里验收**，报告里明说它是无法验收项。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/**
 * 「不许出现某句话」这类断言要在去掉注释的源码上跑：解释禁令的注释里必然带着被禁的那个词，
 * 拿全文去查会自己绊自己。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/memory-panel.tsx');
const PANEL_CODE = stripComments(PANEL);

describe('归档的文案逐字钉住（11-05 批准）', () => {
  it('头部说明要说清三种动作的差别：更正留版本、归档可恢复、永久删除不可恢复', () => {
    expect(PANEL).toContain('更正会留下旧版本，归档随时可以恢复；永久删除不可恢复。');
  });

  it('关闭总开关那句要把「归档」指为逐条停用的入口', () => {
    expect(PANEL).toContain('关闭只停止新的读写，已存下的记忆仍在下面这份列表里。要逐条停掉，用「归档」。');
  });

  it('归档展开区：问句 + 说清影响 + 按钮，三句都在', () => {
    expect(PANEL).toContain('把这条收起来？');
    expect(PANEL).toContain('收起后这条不再进入对话，也不会再被当作洞察的证据。正文和版本都留着，随时可以恢复。');
    expect(PANEL).toContain('确认归档');
  });

  it('已归档区块：标题、说明、行标签、恢复按钮，四句都在', () => {
    expect(PANEL).toContain('已归档');
    expect(PANEL).toContain('这些内容不参与对话，也不会被当作洞察的证据。要重新使用，点「恢复」。');
    expect(PANEL).toContain('已归档 · 记于');
    expect(PANEL).toContain('恢复');
  });

  it('反馈文案两句：归档后不再进入对话，恢复后重新作为当前有效', () => {
    expect(PANEL).toContain("'已归档，这条不再进入对话'");
    expect(PANEL).toContain("'已恢复，这条重新作为当前有效记忆'");
  });
});

describe('控件必须有消费者（任务书 8.2 禁止假交互）', () => {
  it('归档按钮打到归档路由，恢复按钮打到恢复路由', () => {
    expect(PANEL_CODE).toContain('/archive' + '`');
    expect(PANEL_CODE).toContain('/restore' + '`');
    expect(PANEL_CODE).toMatch(/archive`.*method: 'POST'/s);
  });

  it('已归档区块没有内容时整块不渲染：不许摆一段空的「已归档」标题', () => {
    expect(PANEL_CODE).toContain('{archived.length > 0 ? (');
  });

  it('恢复入口只在已归档那一份里有，当前列表不许再摆一个', () => {
    const restoreUses = PANEL_CODE.split('restore`').length - 1;
    expect(restoreUses).toBe(1);
  });
});

describe('两份列表的截断提示各自挂上', () => {
  it('GET 的响应类型里两个标志都得有，不然是界面自己编的数', () => {
    expect(PANEL).toContain('capped: boolean;');
    expect(PANEL).toContain('archivedCapped: boolean;');
  });

  it('当前有效那份用 capped，归档那份用 archivedCapped——两个桶各说各的', () => {
    expect(PANEL_CODE).toContain('describeMemoryListCap(capped, memories.length)');
    expect(PANEL_CODE).toContain('describeArchivedListCap(archivedCapped, archived.length)');
  });

  it('两句提示都真的摆进 JSX：只算出字符串不渲染，等于没说', () => {
    expect(PANEL_CODE).toContain('{capNote ? <Alert tone="info">{capNote}</Alert> : null}');
    expect(PANEL_CODE).toContain(
      '{archivedCapNote ? <Alert tone="info" className="mt-2">{archivedCapNote}</Alert> : null}'
    );
  });

  it('提示语走纯函数，界面不许把句子抄一遍', () => {
    // 抄一份就意味着 memory-display 里那句被钉住的文案可能和界面实际显示的不一样。
    expect(PANEL_CODE).not.toContain('比这一屏多');
  });
});
