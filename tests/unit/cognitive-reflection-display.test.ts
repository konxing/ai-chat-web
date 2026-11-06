import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 洞察一屏（6-F）的展示词汇与降级规则，全部钉在纯函数上。
 *
 * 为什么这一屏只有这个文件可测：vitest 跑在 node 环境，没有 jsdom，JSX 里那些 div 和
 * onClick 在这套测试体系下无法运行——这一点在报告里明说，不假装界面被验过。
 * 但界面里**有真实逻辑**的部分不需要 DOM：标签表会不会渲染出 undefined、
 * 粗粒度时间会不会被显示成精确到日（门槛 6）、已经处理过的行会不会还挂着按钮（状态机只有
 * PENDING 一个入口）。这三件事全是纯函数，先在纯函数上红一次。
 *
 * 文案主体是 11-04 批准的逐字表；生成时间与截断提示两句是他 11-04 让我自拟后补的，
 * 日期口径同日统一到时间线那一屏的「年月日」。这里断言的是字面量本身，不是「差不多」。
 */
import {
  ALTERNATIVES_LINE_PREFIX,
  CITATION_KIND_LABELS,
  COOLDOWN_HINTS,
  COOLDOWN_LABELS,
  COOLDOWN_ORDER,
  PENDING_SUBSECTION_LABELS,
  REFLECTION_CONFIDENCE_LABELS,
  REFLECTION_SECTIONS,
  REFLECTION_SNOOZE_OPTIONS,
  REFLECTION_TYPE_LABELS,
  splitPendingSection,
  describeAlternatives,
  describeCounterEvidence,
  describeEvidenceVolume,
  describeGeneratedAt,
  describeListCap,
  describeReflectionTime,
  formatSnoozeDate,
  isActionable
} from '@/lib/cognitive/reflection-display';
import { CONFIDENCE_BAND_LABELS } from '@/lib/cognitive/memory-display';

/** 枚举成员从 schema 现读，不在这个文件里抄第二份：抄的那一份会先过期。 */
function enumMembers(name: string): string[] {
  const schema = readFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`prisma/schema.prisma 里找不到 enum ${name}`);
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('///') && !line.startsWith('//'));
}

describe('洞察类型标签', () => {
  it('七类反思逐字对上批准的文案表', () => {
    expect(REFLECTION_TYPE_LABELS).toEqual({
      PATTERN: '反复出现的模式',
      GOAL_DRIFT: '目标偏移',
      UNRESOLVED: '悬而未决',
      INTEREST_SHIFT: '兴趣转移',
      CONTRADICTION: '前后矛盾',
      MILESTONE: '里程碑',
      DECISION_LESSON: '决策教训'
    });
  });

  it('标签表的键与 schema 枚举成员一模一样——多一个少一个都算漂移', () => {
    expect(Object.keys(REFLECTION_TYPE_LABELS).sort()).toEqual(enumMembers('ReflectionType').sort());
  });
});

describe('六个状态的分区', () => {
  it('区标题逐字对上批准的文案表', () => {
    expect(REFLECTION_SECTIONS).toEqual([
      { status: 'PENDING', title: '待处理' },
      { status: 'SNOOZED', title: '稍后' },
      { status: 'ACCEPTED', title: '已采纳' },
      { status: 'EDITED', title: '已改写' },
      { status: 'REJECTED', title: '已拒绝' },
      { status: 'EXPIRED', title: '已过期' }
    ]);
  });

  it('schema 里新增一个状态而这里没补，界面就会整段漏掉那一类——这条钉的是集合相等', () => {
    expect(REFLECTION_SECTIONS.map((section) => section.status).sort()).toEqual(
      enumMembers('ReflectionStatus').sort()
    );
  });
});

describe('哪些行还能动作', () => {
  it('只有待处理可以：状态机的入口只有 PENDING，别的行摆按钮就是摆一个必然 409 的控件', () => {
    expect(isActionable('PENDING')).toBe(true);
    for (const status of ['ACCEPTED', 'REJECTED', 'EDITED', 'SNOOZED', 'EXPIRED'] as const) {
      expect(isActionable(status)).toBe(false);
    }
  });

  it('稍后不是「还能改」：到时间由后台放回待处理，中间不许提前处置', () => {
    expect(isActionable('SNOOZED')).toBe(false);
  });
});

describe('时间按精度降级（门槛 6）', () => {
  const at = '2026-09-01T08:30:00.000Z';

  it('精度未知就不显示时间，而不是显示一个看起来像日期的东西', () => {
    expect(describeReflectionTime(at, null, 'UNKNOWN')).toBe('');
    expect(describeReflectionTime(null, null, 'DAY')).toBe('');
  });

  it('只有年就不许露出月和日', () => {
    expect(describeReflectionTime(at, null, 'YEAR')).toBe('2026年');
  });

  it('到月就不许露出日', () => {
    expect(describeReflectionTime(at, null, 'MONTH')).toBe('2026年9月');
  });

  it('到日就不许露出时分', () => {
    expect(describeReflectionTime(at, null, 'DAY')).toBe('2026年9月1日');
  });

  it('时间戳才到分钟', () => {
    expect(describeReflectionTime(at, null, 'TIMESTAMP')).toBe('2026年9月1日 08:30');
  });

  it('有区间就两端同精度拼起来，缺终点就不留分隔符', () => {
    expect(describeReflectionTime('2026-09-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', 'DAY')).toBe(
      '2026年9月1日～2026年10月5日'
    );
    expect(describeReflectionTime(at, null, 'TIMESTAMP')).not.toContain('～');
  });

  it('日期口径和时间线/记忆那两屏一致——同一个项目里同一套精度不该有两种写法', () => {
    const memoryDisplay = readFileSync(
      path.resolve(process.cwd(), 'src/lib/cognitive/memory-display.ts'),
      'utf8'
    );
    expect(memoryDisplay).toContain('`${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`');
    const mine = readFileSync(
      path.resolve(process.cwd(), 'src/lib/cognitive/reflection-display.ts'),
      'utf8'
    );
    expect(mine).toContain('${y}年${mo}月${d}日');
    expect(mine).not.toMatch(/-\$\{pad\(mo\)\}-\$\{pad\(d\)\}/);
  });
});

describe('证据量、反证与竞争解释', () => {
  it('样本数与观察跨度摊开给用户看：数据不足本来就是判据之一（任务书 6.3）', () => {
    expect(describeEvidenceVolume(3, 14)).toBe('基于 3 条记忆，跨 14 天');
    expect(describeEvidenceVolume(1, 0)).toBe('基于 1 条记忆，跨 0 天');
  });

  it('没有反证就不写这一行', () => {
    expect(describeCounterEvidence(0)).toBe('');
    expect(describeCounterEvidence(2)).toBe('找到 2 条相反的证据');
  });

  it('竞争解释是可选的：没有就不留前缀', () => {
    expect(describeAlternatives(null)).toBe('');
    expect(describeAlternatives('可能目标真的换了；可能还是那个目标，只是换了路径')).toBe(
      '这几种解释还没分开：可能目标真的换了；可能还是那个目标，只是换了路径'
    );
    // 前缀只有一个去处：它是文案，界面不许自己拼一份。
    expect(ALTERNATIVES_LINE_PREFIX).toBe('这几种解释还没分开：');
  });

  it('两类依据的前缀逐字对上文案表', () => {
    expect(CITATION_KIND_LABELS).toEqual({ SUPPORTS: '支撑：', CONTRADICTS: '相反：' });
    expect(Object.keys(CITATION_KIND_LABELS).sort()).toEqual(enumMembers('ReflectionCitationKind').sort());
  });
});

describe('置信度档位：这一屏说「把握」，不说「可信度」', () => {
  it('三档逐字钉住：没有第四档，也没有哪一档留白', () => {
    expect(REFLECTION_CONFIDENCE_LABELS).toEqual({ high: '把握大', medium: '把握中', low: '把握小' });
  });

  it('和记忆屏那组「可信度」不是同一个词：两个阈值答的是两个问题（0.7/0.4 对 0.75/0.45）', () => {
    // 记忆那条问「这一句可不可信」，洞察这条问「这几句够不够拼成同一件事」。
    // 共用一个词就是让两个不同算法在同一项目里长出同一个名字，用户读不出差别。
    expect(REFLECTION_CONFIDENCE_LABELS.low).not.toBe(CONFIDENCE_BAND_LABELS.low);
    expect(REFLECTION_CONFIDENCE_LABELS.high).not.toBe(CONFIDENCE_BAND_LABELS.high);
  });

  it('档位是给客户端的那一份：三档之外没有第四档可渲染', () => {
    expect(Object.keys(REFLECTION_CONFIDENCE_LABELS).sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('这一屏没说的两件事（11-04 他让我自拟文案后补上）', () => {
  it('生成时间只到日：它是系统盖的时间戳，摆到分钟只是给一屏卡片增加噪声', () => {
    expect(describeGeneratedAt('2026-11-04T21:37:00.000Z')).toBe('生成于 2026年11月4日');
  });

  it('列表被上限截断时必须说出来，否则用户会把「没有更早的」读成「更早的没发生过」', () => {
    expect(describeListCap(false, 3)).toBe('');
    expect(describeListCap(true, 100)).toBe('洞察比这一屏多：这里只列出最近 100 条，更早的没有读进来。');
  });
});

describe('稍后的三档', () => {
  it('只有 3/7/30 三档，与服务端白名单同宽——任意天数会让推迟变成无限期推迟', () => {
    expect(REFLECTION_SNOOZE_OPTIONS).toEqual([
      { days: 3, label: '3 天' },
      { days: 7, label: '7 天' },
      { days: 30, label: '30 天' }
    ]);
  });

  it('推迟到的日子按天显示，不露时分，日期口径同上一屏', () => {
    expect(formatSnoozeDate('2026-11-07T15:00:00.000Z')).toBe('2026年11月7日');
  });
});

describe('纯模块边界', () => {
  it('除了类型导入，不引用任何服务端模块——客户端组件才能安全引用', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/lib/cognitive/reflection-display.ts'),
      'utf8'
    );
    const runtimeImports = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('import') && !line.startsWith('import type'));
    expect(runtimeImports).toEqual([]);
  });
});

/**
 * 任务书 6.6「最多保留 3 条待确认的高价值洞察作为主要展示」在界面这一侧的落点。
 *
 * 切分规则放在纯函数里，是因为「什么时候该出现第二个小标题」这件事界面说不清：
 * 三条以内全是主要，再挂一对「主要 / 其余」的标题就是自己给自己造噪音（也是他定过的
 * 「不许渲染没有消费者的控件」那一类）。于是这一区到底分不分、标题叫什么，一条用例就能钉死。
 */
describe('待处理一区的两个子区', () => {
  it('两个子区标题逐字钉住：主要 / 其余', () => {
    expect(PENDING_SUBSECTION_LABELS).toEqual({ primary: '主要', rest: '其余' });
  });

  it('超过三条 ⇒ 两组各带标题，组里的成员就是服务端标出来的那批', () => {
    const rows = [
      { id: 'a', isPrimary: true },
      { id: 'b', isPrimary: true },
      { id: 'c', isPrimary: true },
      { id: 'd', isPrimary: false },
      { id: 'e', isPrimary: false }
    ];
    const groups = splitPendingSection(rows);
    expect(groups.map((group) => group.title)).toEqual(['主要', '其余']);
    expect(groups.map((group) => group.rows.map((row) => row.id))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e']
    ]);
  });

  it('三条以内 ⇒ 一整块、一个小标题都不留：那时「主要」就是这一区本身', () => {
    const rows = [
      { id: 'a', isPrimary: true },
      { id: 'b', isPrimary: true }
    ];
    expect(splitPendingSection(rows)).toEqual([{ key: 'all', title: null, rows }]);
  });

  it('一条都不主要 ⇒ 也不挂「主要（0）」这种空区标题', () => {
    // 今天的读侧不会产生这个形状（有待处理行就至少有一条主要）。这条防的是两个模块之间的
    // 契约变动：额度算法若改在别处算，这一屏不许因此出现一个标题下挂着空列表的区。
    const rows = [
      { id: 'a', isPrimary: false },
      { id: 'b', isPrimary: false }
    ];
    expect(splitPendingSection(rows)).toEqual([{ key: 'all', title: null, rows }]);
  });

  it('切分不重排：顺序由服务端那一次排序定，界面再排一次就会和「前 3 条」的口径打架', () => {
    // 输入故意按重要度升序（真实响应不会是这样，正因如此这条测的才是「没偷偷排序」）。
    const rows = [
      { id: 'low', isPrimary: false },
      { id: 'mid', isPrimary: true },
      { id: 'high', isPrimary: true }
    ];
    const groups = splitPendingSection(rows);
    expect(groups.map((group) => group.rows.map((row) => row.id))).toEqual([
      ['mid', 'high'],
      ['low']
    ]);
  });
});

/**
 * 片Q-5：任务书 6.6 :722 的「可配置的冷却规则」上屏。
 *
 * 三档的词放在这里而不是面板里，和「主要/其余」同一个来由：面板只许渲染，不许自己带文案。
 * 顺序也钉死——`daily` 排第一不是排版选择，它是默认档，而 select 打开时用户看到的第一个
 * 选项就是他当前所在的这一档。
 */
describe('洞察生成节奏三档', () => {
  it('档位逐字对上批准的文案，默认档排在第一位', () => {
    expect(COOLDOWN_ORDER).toEqual(['daily', 'weekly', 'monthly']);
    expect(COOLDOWN_LABELS).toEqual({ daily: '每天', weekly: '每周', monthly: '每月' });
    expect(COOLDOWN_HINTS).toEqual({
      daily: '距上次生成满 24 小时。这是默认档，也是加上这一项之前写死的节奏。',
      weekly: '距上次生成满 7 天。',
      monthly: '距上次生成满 30 天。'
    });
  });

  it('词表的键与 schema 枚举成员一一对上：多一档少一档，界面上就会出现 undefined 或死选项', () => {
    expect(Object.keys(COOLDOWN_LABELS).sort()).toEqual(
      enumMembers('ReflectionCooldown')
        .map((member) => member.toLowerCase())
        .sort()
    );
    expect(Object.keys(COOLDOWN_HINTS).sort()).toEqual(Object.keys(COOLDOWN_LABELS).sort());
    expect(COOLDOWN_ORDER).toHaveLength(enumMembers('ReflectionCooldown').length);
  });
});
