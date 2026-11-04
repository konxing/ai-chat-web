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
 *    画像与关联两列至今没有运行时代码读它们。这三条任何一条破了，界面上就会出现一个必然报错或
 *    必然无效的控件——那正是任务书第八节点名禁止的「用假的交互代替」。
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

  it('画像与关联两列至今没有消费者，所以策略面板依旧不许给它们控件', () => {
    expect(stripComments(POLICY_PANEL)).not.toContain('allowUserProfile');
    expect(stripComments(POLICY_PANEL)).not.toContain('allowAssociation');
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
    // 而行首匹配还会把 `importance: number;` 这种字段当成 import（'importance' 以 'import' 开头）。
    const specifiers = [...PANEL.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers).toContain('@/lib/cognitive/reflection-display');
    expect(specifiers.filter((name) => name.startsWith('@/lib/cognitive/'))).toEqual([
      '@/lib/cognitive/reflection-display'
    ]);
    expect(specifiers).not.toContain('@prisma/client');
  });
});

describe('设置页接线', () => {
  it('tab 三处都到位：导航项、渲染分支、Tab 联合类型', () => {
    expect(WORKSPACE).toContain("['reflections', '洞察', Lightbulb]");
    expect(WORKSPACE).toContain("{tab === 'reflections' ? <ReflectionPanel /> : null}");
    expect(WORKSPACE).toContain("'reflections'");
  });
});
