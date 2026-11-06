import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 洞察一屏的静态断言（6-F）。
 *
 * 为什么不跑用例：vitest 跑在 node 环境，这套测试体系里没有 jsdom 和渲染器，JSX 里的 div 和
 * onClick 根本没法运行。所以这一屏能验的两件事都用读源码的方式验：
 * 一、**批准的文案不许被悄悄改掉**。2026-11-04 那张逐字表是他过目的产物，改一个标点就等于改了
 *    用户看到的句子；把这些句子钉在这里，下次有人顺手「润色」一下就会红。
 * 二、**不许出现没有消费者的交互**。2 判的是乙：改写这一版不给入口；状态机只有 PENDING 一个入口；
 *    策略表的三个下游许可各自要先有运行时读者才拿到控件（画像列片 d、关联列片 j）。
 *    这三条任何一条破了，界面上就会出现一个必然报错或必然无效的控件——那正是任务书第八节点名禁止的「用假的交互代替」。
 *
 * 界面本身（像素、点击、真实数据下的排布）**不在这里验收**，报告里明说它是无法验收项。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/**
 * 「不许出现某句话」这类断言要在去掉注释的源码上跑：文件头的注释正是解释禁令的地方，
 * 里面必然提到被禁的那个词（「这里不许出现『已记住』」），拿全文去查会自己绊自己。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/reflection-panel.tsx');
const PANEL_CODE = stripComments(PANEL);
const POLICY_PANEL = read('src/components/settings/memory-policy-panel.tsx');
const WORKSPACE = read('src/components/settings/settings-workspace.tsx');

describe('批准的文案逐字钉住', () => {
  it('面板标题与说明：必须说清「不会在聊天里被主动提起」（这一版没有读侧注入）', () => {
    expect(PANEL).toContain('AI 主动洞察');
    expect(PANEL).toContain(
      '开启后，系统会定期从你已保存的记忆里找反复出现的模式、前后矛盾和长期未定的事，摆在这里等你处置。这些洞察不会在聊天里被主动提起。'
    );
  });

  it('开关三态与未开启提示', () => {
    expect(PANEL).toContain('开关状态未知');
    expect(PANEL).toContain('主动洞察没有打开');
    expect(PANEL).toContain('主动洞察已打开');
    expect(PANEL).toContain('主动洞察已关闭');
  });

  it('空态：不摆「马上就有」的承诺，说清一天最多三条且证据不足就不说', () => {
    expect(PANEL).toContain('还没有洞察');
    expect(PANEL).toContain(
      '洞察一天最多生成三条，且只在你的记忆攒够证据时生成。今天没话可说，它就真的不说。'
    );
  });

  it('三个动作的后效文案：采纳那句必须明说「不会写进你的记忆」（6-B 判的甲）', () => {
    expect(PANEL).toContain('采纳');
    expect(PANEL).toContain('拒绝');
    expect(PANEL).toContain('稍后');
    expect(PANEL).toContain('已采纳。这条洞察只记为「你看过并同意」，不会写进你的记忆。');
    expect(PANEL).toContain('已拒绝。只有以后新记进同话题的一句话，才会让它再出现。');
    expect(PANEL).toContain('已推迟到');
  });

  it('依据区与过期行', () => {
    expect(PANEL).toContain('依据');
    expect(PANEL).toContain('这条洞察没有可展示的原始依据。');
    expect(PANEL).toContain('这条洞察 30 天没人处理，已过期');
  });

  it('策略面板的反思控件两句话', () => {
    expect(POLICY_PANEL).toContain('允许从这种情境里反思');
    expect(POLICY_PANEL).toContain('关掉后，这种情境里记下的内容不再作为洞察的依据。');
  });

  it('不许出现「已记住」这一类话：它会让用户以为采纳等于承认了一条记忆', () => {
    expect(PANEL_CODE).not.toContain('已记住');
    expect(PANEL_CODE).not.toContain('我会记住');
    expect(PANEL_CODE).not.toContain('已写入');
  });
});

describe('不许有没人消费的交互', () => {
  it('2 判的是乙：这一版不给「改写」入口——服务端实现了，界面上不露', () => {
    expect(PANEL_CODE).not.toMatch(/action:\s*'edit'/);
    expect(PANEL_CODE).not.toContain('改写');
  });

  it('动作按钮只由 isActionable 决定，不在界面里另抄一份「PENDING」判断', () => {
    expect(PANEL).toContain('isActionable');
    expect(PANEL).toContain('actionable ?');
    expect(PANEL_CODE).not.toContain("status === 'PENDING' ? (");
  });

  /**
   * 11-04 那版这条是「关联一列没有消费者，所以不给控件」。片 j 给它在记忆网络的派生层
   * 找到了读者（`memory-graph.ts` 的关联池），按仓库自己的立场——先有代码读它，再给它控件——
   * 这一列现在有复选框了。三条一起钉，是因为「哪个字段有读者」这件事只能靠这里逐条记账。
   */
  it('三个下游许可都有消费者了，所以三个都有控件', () => {
    for (const field of ['allowReflection', 'allowUserProfile', 'allowAssociation']) {
      expect(stripComments(POLICY_PANEL)).toContain(field);
      expect(POLICY_PANEL).toContain(`draft.${field}`);
      expect(POLICY_PANEL).toMatch(new RegExp(`checked=\\{draft\\.${field}\\}`));
    }
  });

  it('关联那一列的说法：关的是「连线」，不是那条记忆本身', () => {
    expect(POLICY_PANEL).toContain('关掉后，这种情境里的记忆不再和别的记忆连关联线；它自己的更新关系照旧。');
  });

  /**
   * 钉的是「加了复选框不等于改得动」：这一屏用 `isSameDraft(draft, toDraft(policy))` 算脏，
   * 脏了才让存。草稿里多一个字段而脏检查漏了它，用户单独拨这个开关时界面永远显示「没有改动」，
   * 保存按钮死着——控件在，路不通。所以字段表从源码里读，不在这儿抄一份。
   */
  it('草稿里的每个字段都参与脏检查：漏一个就存不了那一个改动', () => {
    const draftBlock = POLICY_PANEL.match(/interface Draft \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const sameBlock = POLICY_PANEL.match(/function isSameDraft\([\s\S]*?\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const fields = [...draftBlock.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]);
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const field of fields) {
      expect(sameBlock).toContain(field);
    }
  });
});

describe('闸门与日志口径', () => {
  it('开关没打开就一个请求都不发（这一屏读的是密文）', () => {
    expect(PANEL).toContain('if (enabled === true) void load();');
  });

  it('洞察正文不进日志：这个文件里没有 console', () => {
    expect(PANEL_CODE).not.toContain('console.');
  });

  it('原话已经不在了就不编一句：只列拿到文本的那几条引用', () => {
    expect(PANEL).toContain('citation.text !== null');
  });
});

describe('6-G：被截断要说出来，每行要说是哪天生成的', () => {
  it('capped 不再是读进来就扔掉——它必须渲染成一句说明', () => {
    expect(PANEL).toContain('capped: boolean');
    expect(PANEL).toContain('setCapped(data.capped)');
    expect(PANEL).toContain('const capNote = describeListCap(capped, reflections.length);');
    expect(PANEL).toContain('{capNote ? <Alert tone="info">{capNote}</Alert> : null}');
  });

  it('生成时间摆在类型 chip 那一行，只到日', () => {
    expect(PANEL).toContain('describeGeneratedAt(reflection.generatedAt)');
  });

  it('界面里不许自己拼日期字符串：日期口径只有 reflection-display 一处（11-04 判的统一）', () => {
    expect(PANEL_CODE).not.toMatch(/getUTCFullYear/);
    expect(PANEL_CODE).not.toMatch(/new Date\(/);
  });
});

describe('客户端包边界', () => {
  it('面板只许引用 reflection-display，不许把带 prisma 的服务端模块拖进浏览器包', () => {
    // 按 from 子句取模块名，不按行首 import：多行 import 的模块名不在 import 那一行上，
    // 而行首匹配会把字段声明（片Q-3 之前的 `importance: number;` 就以 'import' 开头）当成 import。
    const specifiers = [...PANEL.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers).toContain('@/lib/cognitive/reflection-display');
    expect(specifiers.filter((name) => name.startsWith('@/lib/cognitive/'))).toEqual([
      '@/lib/cognitive/reflection-display'
    ]);
    expect(specifiers).not.toContain('@prisma/client');
  });
});

/**
 * 片Q-2 的第二半：一句解释在这屏只有一个去处。
 *
 * 之前它有两处——措辞层把它抄进正文（`分不开这几种解释：…`），落库那份又单独渲染一行。
 * 于是同一屏里系统把同样的话讲了两遍，而 sweep 还得把措辞层的推导重做一遍。
 * 界面这一侧要钉的是：它既不自己拼第三份文案，也不把两行合成一行的职责揽过来。
 */
describe('一句解释只渲染一次', () => {
  it('解释行只由 describeAlternatives 拼，前缀不在界面里另抄一份', () => {
    expect(PANEL).toContain('const alternativesLine = describeAlternatives(reflection.alternatives);');
    expect((PANEL_CODE.match(/describeAlternatives\(/g) ?? [])).toHaveLength(1);
    expect(PANEL_CODE).not.toContain('这几种解释');
    expect(PANEL_CODE).not.toContain('可能');
  });

  it('正文与解释各渲染一次：同一句话不许在这屏出现两遍', () => {
    expect((PANEL_CODE.match(/\{reflection\.body\}/g) ?? [])).toHaveLength(1);
    expect((PANEL_CODE.match(/\{alternativesLine\}/g) ?? [])).toHaveLength(1);
    expect((PANEL_CODE.match(/\{reflection\.title\}/g) ?? [])).toHaveLength(1);
  });
});

/**
 * 片Q-3：置信度终于上屏，但它带来一条更硬的口径——**分数不出服务端**。
 * 记忆屏（1b）早就是这个形状：服务里是分数，出了服务端只剩档位。这一屏照抄，
 * 并且把「界面不许自己算档」钉在这里：档位算法只有一份，在 reflection-evidence.ts。
 */
describe('置信度档位上屏', () => {
  it('档位文案只从 REFLECTION_CONFIDENCE_LABELS 取：界面不拼第三份文案', () => {
    expect(PANEL).toContain('  REFLECTION_CONFIDENCE_LABELS,');
    expect((PANEL_CODE.match(/REFLECTION_CONFIDENCE_LABELS\[/g) ?? [])).toHaveLength(1);
    expect(PANEL_CODE).toContain('REFLECTION_CONFIDENCE_LABELS[reflection.confidenceBand]');
    // 「把握大/中/小」这三个字只许活在 reflection-display.ts 里。
    expect(PANEL_CODE).not.toContain('把握');
  });

  it('界面上没有分数：不带 toFixed，DTO 里也没有 confidence / importance 两个数', () => {
    expect(PANEL_CODE).not.toContain('.toFixed(');
    expect(PANEL_CODE).not.toMatch(/confidence:\s/);
    expect(PANEL_CODE).not.toContain('importance');
  });

  it('两张 chip 的先后：类型在前、把握在后，都在标题之上（先说这是什么，再说有多确定）', () => {
    const typeChip = PANEL_CODE.indexOf('REFLECTION_TYPE_LABELS[reflection.type]');
    const bandChip = PANEL_CODE.indexOf('REFLECTION_CONFIDENCE_LABELS[reflection.confidenceBand]');
    const title = PANEL_CODE.indexOf('{reflection.title}');
    expect(typeChip).toBeGreaterThan(-1);
    expect(bandChip).toBeGreaterThan(typeChip);
    expect(bandChip).toBeLessThan(title);
  });
});

/**
 * 片Q-4：「主要展示」这一屏只做一件事——按服务端给的标记把待处理那一区分成两块。
 *
 * 这里防的是界面自己长出第二套排名：额度（3 条）和尺子（importance）都在读侧，
 * 界面若再 sort 一次或 slice 一次，同一批行就会在「库里排出来的前三」和「屏幕上看到的前三」
 * 之间分叉，而那正是片Q-3 用 `confidenceBandOf` 避免过的同一个病。
 */
describe('主要展示的切分只在服务端定，界面不重排', () => {
  it('切分只调一次 splitPendingSection，且面板不自己引那个数', () => {
    // 钉的是「从 reflection-display 那一条 import 进来的」，不钉换行和逗号怎么排。
    expect(PANEL).toMatch(
      /import \{[^}]*\bsplitPendingSection\b[^}]*\} from '@\/lib\/cognitive\/reflection-display'/
    );
    expect((PANEL_CODE.match(/splitPendingSection\(/g) ?? [])).toHaveLength(1);
    // isPrimary 在这个文件里只许出现在 DTO 那一行声明上：出现第二处就说明界面在读它做判断。
    expect((PANEL_CODE.match(/isPrimary/g) ?? [])).toHaveLength(1);
  });

  it('界面既没排序也没截断：排序与额度是读侧那一次的事', () => {
    expect(PANEL_CODE).not.toMatch(/\.sort\(/);
    expect(PANEL_CODE).not.toMatch(/\.slice\(/);
    expect(PANEL_CODE).not.toMatch(/importance/i);
  });

  it('两个小标题只从 group.title 渲染，文案不在界面里另抄一份', () => {
    expect((PANEL_CODE.match(/\{group\.title\}/g) ?? [])).toHaveLength(1);
    expect(PANEL_CODE).not.toContain('主要');
    expect(PANEL_CODE).not.toContain('其余');
  });
});

describe('设置页接线', () => {
  it('tab 三处都到位：导航项、渲染分支、Tab 联合类型', () => {
    expect(WORKSPACE).toContain("['reflections', '洞察', Lightbulb]");
    expect(WORKSPACE).toContain("{tab === 'reflections' ? <ReflectionPanel /> : null}");
    expect(WORKSPACE).toContain("'reflections'");
  });
});
