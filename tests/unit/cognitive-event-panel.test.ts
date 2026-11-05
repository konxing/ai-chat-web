import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 4.1「事件类别」接到时间线那一屏上的静态断言（片i-4）。
 *
 * 项目没有组件测试（vitest 跑在 node 环境，没有 jsdom，JSX 和 onClick 都跑不起来），
 * 所以这一屏能验的事只能用读源码的方式验。这一片盯的是三件会真出错的事：
 *
 * 一、**筛选口径只有一个出处**。任务书 4.4 要「按事件类别筛选」，类别名住在
 *    `event-display.ts` 那张表里；界面里再抄一份字面量，改了表的就是没显示的那一份。
 * 二、**不摆没人能点的按钮**。chips 只列这一批里真出现过的类别——12 类里有 3 类
 *    这一屏不生成，把 9 个按钮硬摆出来，用户点了三个「这个类别还没有事件」，
 *    就会以为系统里有那些事件但这一批没筛出来。
 * 三、**少掉的那 3 类要说出来**。不生成是因为现有记录里没有对应的列，
 *    这句必须来自 `UNEMITTED_EVENT_KIND_NOTE` 同一段话，界面不许另编一套说法。
 *
 * 界面本身（真实数据下好不好读、chips 多了会不会挤爆这一屏）**不在这里验收**，
 * 文档里明说它是无法验收项。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/timeline-panel.tsx');
const PANEL_CODE = stripComments(PANEL);

/** `event-display.ts` 那张表的全部中文说法，界面里出现任何一个就是两份开始漂了。 */
const KIND_LABELS = [
  '一段经历',
  '定下目标',
  '目标改了说法',
  '目标完成',
  '新提起的事',
  '兴趣转移',
  '偏好改了说法',
  '新项目',
  '项目更新',
  '里程碑',
  '一项挑战',
  '一个决定'
];

/** 12 个类别名。界面只该读事件行自带的 `kind`，不该自己判类别——那是抽取层的事。 */
const KIND_NAMES = [
  'EXPERIENCE',
  'GOAL_CREATED',
  'GOAL_CHANGED',
  'GOAL_COMPLETED',
  'INTEREST_EMERGED',
  'INTEREST_SHIFTED',
  'PREFERENCE_CHANGED',
  'PROJECT_STARTED',
  'PROJECT_UPDATED',
  'MILESTONE',
  'CHALLENGE',
  'DECISION_MADE'
];

describe('筛选读的是事件类别', () => {
  it('chips 由这一批里真出现过的类别驱动，不是固定摆一排', () => {
    expect(PANEL_CODE).toContain('FILTERABLE_EVENT_KINDS.filter(');
    expect(PANEL_CODE).toContain('events.some((event) => event.kind === kind)');
    expect(PANEL_CODE).toContain('describeEventKind(item)');
  });

  it('记忆类型不再当筛选口径', () => {
    expect(PANEL_CODE).not.toContain('TYPE_ORDER');
    expect(PANEL_CODE).not.toContain('event.category === filter');
  });

  it('筛的是 kind，筛选状态和类别同一个词汇表', () => {
    expect(PANEL_CODE).toContain('events.filter((event) => event.kind === activeFilter)');
    expect(PANEL_CODE).toContain("type Filter = EventKind | 'all'");
  });

  /** chips 会跟着这一批变短：永久删掉某类最后一条后，筛选项自己没了，再留着就是空得没有原因。 */
  it('这一批里不再有刚选的那个类别时退回全部', () => {
    expect(PANEL_CODE).toContain('presentKinds.includes(filter)');
    expect(PANEL_CODE).toContain("activeFilter === 'all'");
  });

  /** 事件行上没有 kind 就什么都筛不了：state 必须是带 kind 的那个形状。 */
  it('事件列表的状态带 kind，读的是抽取层的类型', () => {
    expect(PANEL_CODE).toContain('CognitiveEvent[]');
    expect(PANEL).toMatch(/import type \{[^}]*CognitiveEvent[^}]*\} from '@\/lib\/cognitive\/event-extractor'/);
  });
});

describe('类别名字只有一个出处', () => {
  it('每条事件的类别走 describeEventKind', () => {
    expect(PANEL_CODE).toContain('describeEventKind(event.kind)');
  });

  it('界面里不许另抄类别的说法', () => {
    for (const phrase of KIND_LABELS) expect(PANEL_CODE).not.toContain(phrase);
  });

  it('界面里不许出现类别名常量，判类别不在这一屏', () => {
    for (const kind of KIND_NAMES) expect(PANEL_CODE).not.toContain(kind);
  });
});

describe('少掉的三类要说出来', () => {
  it('那句说明来自 event-display 的常量，不是界面另写的', () => {
    expect(PANEL_CODE).toContain('{UNEMITTED_EVENT_KIND_NOTE}');
    expect(PANEL).toContain("UNEMITTED_EVENT_KIND_NOTE");
  });

  /** 开关关着时这一屏连记忆都不读，那句「这一屏生成 9 类」就没有依据。 */
  it('说明挂在闸门打开那一支里，且跟 chips 同一个条件', () => {
    const at = PANEL_CODE.indexOf('{UNEMITTED_EVENT_KIND_NOTE}');
    expect(at).toBeGreaterThan(PANEL_CODE.indexOf('enabled === true ? ('));
    expect(at).toBeGreaterThan(PANEL_CODE.indexOf('describeEventKind(item)'));
  });
});

describe('记忆类型仍然是行上的数据', () => {
  /** 类别是读派生层的，不是界面自己从 type 推的；type 那一格照旧摆出来。 */
  it('每条事件还挂着记忆类型', () => {
    expect(PANEL_CODE).toContain('TYPE_LABELS[event.category]');
    expect(PANEL_CODE).toContain('CONTEXT_LABELS[event.context]');
    expect(PANEL_CODE).toContain('ORIGIN_LABELS[event.origin]');
  });

  it('发生时间未知那条红旗没被类别挤掉', () => {
    expect(PANEL_CODE).toContain('发生时间未知');
    expect(PANEL_CODE).toContain('event.timeSource === ');
  });
});

describe('一个动作一个入口：这一片不加控件', () => {
  it('开关还是只有一个，写动作还是那一对端点', () => {
    expect(PANEL_CODE.match(/type="checkbox"/g)?.length).toBe(1);
    expect(PANEL_CODE.match(/const [A-Z_]+_URL/g)?.length).toBe(3);
    expect(PANEL_CODE).not.toContain('/api/account/cognitive/changes');
    expect(PANEL_CODE).not.toContain('归档');
  });

  it('抽取层只以 import type 的形式出现在这一屏', () => {
    const withoutTypeImports = PANEL.replace(/import type [\s\S]*?from\s+'[^']+';/g, '');
    expect(withoutTypeImports).not.toContain('event-extractor');
    expect(withoutTypeImports).not.toContain('@prisma/client');
    const cognitive = [
      ...new Set([...withoutTypeImports.matchAll(/\bfrom\s+'(@\/lib\/cognitive\/[^']+)'/g)].map((m) => m[1]))
    ].sort();
    expect(cognitive).toEqual(['@/lib/cognitive/event-display', '@/lib/cognitive/memory-display']);
  });

  it('界面不直接读那张表，只走取值函数', () => {
    expect(PANEL_CODE).not.toContain('EVENT_KIND_LABELS');
  });
});
