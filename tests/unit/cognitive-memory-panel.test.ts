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

/**
 * 再巩固标记和访问次数（任务书 7.1 在这一屏的落点）。
 *
 * 这一簇断言守的是三条：
 * 一、中文只在 memory-display 里有一份。界面自己拼句子，就等于允许它和服务端那句漂移。
 * 二、数字只能来自服务端交回来的那份旁表，界面不许把 200 的常量抄一份——
 *    抄的那一份会先过期，而且截断时说出来的窗口是个假数。
 * 三、没有标记和零次访问不许摆空芯片：满屏的空标签和没有标签一样吵，但会假装「算过了」。
 */
describe('再巩固标记与访问次数（任务书 7.1）', () => {
  it('GET 交回来的四样旁表在响应类型里都得有，不然是界面自己编的数', () => {
    expect(PANEL).toContain('reviews: Record<string, ReconsolidationFlag[]>;');
    expect(PANEL).toContain('access: Record<string, number>;');
    expect(PANEL).toContain('accessWindow: number;');
    expect(PANEL).toContain('accessCapped: boolean;');
  });

  it('标记的中文走标签表，界面上不许出现「新的支持信息」「已过期」这类自己写的话', () => {
    expect(PANEL_CODE).toContain('RECONSOLIDATION_LABELS');
    expect(PANEL_CODE).not.toContain('新的支持信息');
    expect(PANEL_CODE).not.toContain('需要更新摘要');
    expect(PANEL_CODE).not.toContain('需要修改关联关系');
  });

  it('次数和截断句子都走纯函数，界面一个字都不抄', () => {
    expect(PANEL_CODE).toContain('describeAccessCount(accessWindow, count)');
    expect(PANEL_CODE).toContain('describeAccessCap(accessCapped, accessWindow)');
    expect(PANEL_CODE).not.toContain('里被带到');
    expect(PANEL_CODE).not.toContain('访问记录比这一屏多');
  });

  it('窗口轮数用的是响应里的 accessWindow，不是把 200 写进组件', () => {
    expect(PANEL_CODE).not.toMatch(/最近 200 轮/);
    expect(PANEL_CODE).toContain('accessWindow');
  });

  it('有标记才挂芯片、有记录才报次数：零和空数组不许渲染', () => {
    expect(PANEL_CODE).toMatch(/flags\.length > 0/);
    expect(PANEL_CODE).toMatch(/count !== undefined[\s\S]{0,400}describeAccessCount/);
  });

  it('这些标记只出现在当前有效那一份里，归档那份一个字都不摆', () => {
    // 归档行不参与再巩固检查（服务端也没给它算），界面去读 reviews[archivedId] 只会拿到 undefined，
    // 但更硬的断言是：已归档区块里根本不许出现这套芯片。
    const archivedBlock = PANEL_CODE.slice(PANEL_CODE.indexOf('{archived.length > 0 ? ('));
    expect(archivedBlock).not.toContain('RECONSOLIDATION_LABELS');
    expect(archivedBlock).not.toContain('describeAccessCount');
  });

  it('界面不自算置信度：档位只从旁表读，标记不参与评分（任务书 7.1 的红线）', () => {
    expect(PANEL_CODE).not.toContain('assessConfidence');
    expect(PANEL_CODE).not.toContain('assessWithCounts');
    expect(PANEL_CODE).not.toContain('listAccessStats');
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

/**
 * 任务书 7.3 在这一屏补上的两臂：「忘记某个主题」和「暂停长期记忆写入」。
 *
 * 这一簇断言守的四件事：
 * 一、主题按钮打到的是 `scope=context`，范围用的是行上已有的那个情境——界面不许自己现编一个词当主题。
 * 二、确认框必须说清这一臂的两条边界：原对话不动、决策记录不在范围内。
 *    「不得擅自删除原会话」是任务书点名的红线，而这一臂和按会话那一臂删的东西确实不一样，文案含糊就等于撒谎。
 * 三、「删掉已经记住的」和「让它不再记」是两个动作，界面上不许顺手合并：
 *    删除只建原句排除，同义改写归策略那层管，得由用户自己另外去点。
 * 四、暂停写入只在总开关打开时才摆出来——总开关一关，写入本来就停了，再摆一个控件就是假交互。
 */
describe('忘记某个主题（任务书 7.3 的第三臂）', () => {
  it('打到 scope=context，范围取自这一行自己的情境，不是界面现编的词', () => {
    expect(PANEL_CODE).toContain('scope=context&context=${encodeURIComponent(context)}');
    expect(PANEL_CODE).toContain('const context = memory.context');
  });

  it('主题名走情境标签表：界面不许把七个枚举的中文自己写一遍', () => {
    expect(PANEL_CODE).toContain('CONTEXT_LABELS[context]');
    expect(PANEL_CODE).toMatch(/title: `忘记「\$\{CONTEXT_LABELS\[context\]\}」这个主题的全部记忆？`/);
  });

  it('确认框逐字说清两条边界：原对话保留、决策记录不在范围内', () => {
    expect(PANEL).toContain('对话本身保留，其它主题和决策记录都不动。');
  });

  it('确认框还要说清「删掉的会再长回来」这件事，并指向另一个动作', () => {
    expect(PANEL).toContain('同一个主题的新说法还会照常记下来；要让它不再记，去「记忆策略」里关掉这个主题的写入。');
  });

  it('删除中把这一行的按钮一起挡住：忙态按主题分桶，和按会话那一路共用同一个闸门', () => {
    expect(PANEL_CODE).toContain('const contextPurgeBusy = bulkBusy === `context:${memory.context}`');
    expect(PANEL_CODE).toContain("{contextPurgeBusy ? '删除中…' : '忘记这个主题'}");
  });

  it('删完要重读排除表：原句排除是这一臂顺手建起来的，不刷新就等于没生效', () => {
    expect(PANEL_CODE).toMatch(/purgeByContext[\s\S]{0,1200}Promise\.all\(\[load\(\), loadExclusions\(\)\]\)/);
  });
});

describe('暂停长期记忆写入（任务书 7.3 的第五臂）', () => {
  it('控件打到 memoryWritePaused 这一列，取的是服务端回的值', () => {
    expect(PANEL_CODE).toContain('json: { memoryWritePaused: !paused }');
    expect(PANEL_CODE).toContain('setPaused(data.preferences.memoryWritePaused)');
  });

  it('状态未知时不许假装它是关着的：和总开关同一个口径', () => {
    expect(PANEL_CODE).toMatch(/disabled=\{paused === null \|\| flagBusy\}/);
  });

  it('暂停的说法要说清「已记住的照常带入」：它不是关闭记忆', () => {
    expect(PANEL).toContain('已暂停新的记忆写入，已记住的内容照常带入对话');
  });

  it('只在总开关真开着时才摆出来：关着的模块不需要一个暂停键', () => {
    expect(PANEL_CODE).toMatch(/\{enabled === true \? \([\s\S]{0,400}暂停长期记忆写入/);
  });

  it('切总开关时也要同步暂停态：两个控件读的是同一份偏好行', () => {
    const enabledToggle = PANEL_CODE.slice(
      PANEL_CODE.indexOf('async function toggleEnabled()'),
      PANEL_CODE.indexOf('async function togglePaused()')
    );
    expect(enabledToggle).toContain('setPaused(data.preferences.memoryWritePaused)');
  });
});
