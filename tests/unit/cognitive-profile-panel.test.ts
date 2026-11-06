import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_CANDIDATE_MEMORY_NOTE,
  PROFILE_CANDIDATE_REFLECTION_NOTE,
  PROFILE_EDITED_LABEL,
  describeConfirmedAt,
  describeEntrySources,
  describeProfileCap
} from '@/lib/cognitive/user-profile-display';

/**
 * 画像一屏的静态断言 + 界面词表的纯函数用例（任务书 8.2 / 8.3）。
 *
 * 和洞察那一屏一样，vitest 跑在 node 环境，没有 jsdom，所以界面本身不在这里验收，报告里明说它是无法验收项。
 * 这里验的是能验的两件事：
 * 一、**批准的文案逐字钉住**，尤其是那两条候选标注——它们必须和服务端派生层用的是同一个常量，
 *    因为「系统推断」和「你亲口说的」在界面上长得一模一样，是这套设计最不能出错的地方。
 * 二、**不许出现没有消费者的交互**：画像这一屏不摆 `emotionEnabled`，它的读者和控件都在「记忆策略」那一屏
 *    （片U），同一件事不许有两个入口；
 *    画像条目的来源是「确认那一刻的依据」，所以改正文那扇门不许带来源编辑控件。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/profile-panel.tsx');
const PANEL_CODE = stripComments(PANEL);
const POLICY_PANEL = read('src/components/settings/memory-policy-panel.tsx');
const POLICY_PANEL_CODE = stripComments(POLICY_PANEL);
const WORKSPACE = read('src/components/settings/settings-workspace.tsx');

describe('界面词表：三个纯函数', () => {
  it('截断说明只在 capped 时出现，条数取实际列出的行数', () => {
    expect(describeProfileCap(false, 12)).toBe('');
    expect(describeProfileCap(true, 200)).toBe(
      '画像条目比这一屏多：这里只列出最近 200 条，更早的没有读进来。'
    );
  });

  it('确认时间只到日，口径和洞察、时间线那两屏一样', () => {
    expect(describeConfirmedAt('2026-11-05T23:30:00.000Z')).toBe('确认于 2026年11月5日');
  });

  it('依据那一句按真实有的那几类拼，两样都没有就是空串', () => {
    expect(describeEntrySources(['m1', 'm2'], [])).toBe('依据：2 条记忆');
    expect(describeEntrySources([], ['r1'])).toBe('依据：1 条洞察');
    expect(describeEntrySources(['m1'], ['r1', 'r2'])).toBe('依据：1 条记忆 · 2 条洞察');
    // 亲笔写的那条本来就没有依据，界面不替它编一个「依据：0 条」。
    expect(describeEntrySources([], [])).toBe('');
  });
});

describe('批准的文案逐字钉住', () => {
  it('标题与说明：说清「只有你确认过的才存下来」和最多带几条给模型', () => {
    expect(PANEL).toContain('用户画像');
    expect(PANEL).toContain('只有你点过「收进画像」的才会存下来');
    expect(PANEL).toContain('对话时最多带最近 6 条给模型');
  });

  it('候选的两条标注用词表常量，不在界面里另写一份', () => {
    expect(PANEL).toContain('{candidate.note}');
    // 逐字的真相在服务端派生层：这里断的是同两个常量确实存在、措辞没被谁顺手改掉。
    expect(PROFILE_CANDIDATE_MEMORY_NOTE).toBe('来自你已经说过或确认过的记忆，收不收进画像由你确认');
    expect(PROFILE_CANDIDATE_REFLECTION_NOTE).toBe('系统推断，未经你确认');
    expect(PROFILE_EDITED_LABEL).toBe('（改过）');
  });

  it('两个区、空态、写入与清空的入口都有确定措辞', () => {
    expect(PANEL).toContain('待你确认的候选');
    expect(PANEL).toContain('你确认过的画像');
    expect(PANEL).toContain('没有候选。系统只在你的记忆攒够依据时才提出，凑不满就不提。');
    expect(PANEL).toContain('title="画像还是空的"');
    expect(PANEL).toContain('你可以自己写一条，也可以等系统摆出候选后由你确认。');
    expect(PANEL).toContain('收进画像');
    expect(PANEL).toContain('写下这条');
    expect(PANEL).toContain('清空全部画像');
  });

  it('动作后的说明：清空画像必须说清「一条记忆都没动」（8.2 的边界）', () => {
    expect(PANEL).toContain('已收进画像。');
    expect(PANEL).toContain('已写下这条。');
    expect(PANEL).toContain('已改过这条。');
    expect(PANEL).toContain('已删除这条画像。');
    expect(PANEL).toContain('已清空画像，你的记忆一条都没动。');
  });

  it('开关三态与未开启提示', () => {
    expect(PANEL).toContain('开关状态未知');
    expect(PANEL).toContain('用户画像没有打开');
    expect(PANEL).toContain('画像已打开');
    expect(PANEL).toContain('画像已关闭');
  });

  it('画像条目跟着「改过」的标注，来自词表而不是界面自己拼', () => {
    expect(PANEL).toContain('PROFILE_EDITED_LABEL');
    expect(PANEL).toContain('describeEntrySources');
    expect(PANEL).toContain('describeConfirmedAt');
    expect(PANEL).toContain('const capNote = describeProfileCap(capped, entries.length);');
  });
});

describe('不许有没人消费的交互', () => {
  it('情绪总开关有读者了才摆控件：这一屏仍然不摆它', () => {
    // 这一屏的禁令不变——它的读者在抽取层和记忆模块，控件住在「记忆策略」那一屏（片U），
    // 画像这一屏不许出现第二个入口。
    expect(PANEL_CODE).not.toContain('emotionEnabled');
    expect(POLICY_PANEL_CODE).toContain('emotionEnabled');
  });

  it('能用的情绪控件只有三档 transparency：它真的被渲染侧读（片 d-4）', () => {
    expect(POLICY_PANEL).toContain('emotionTransparency');
    expect(POLICY_PANEL).toContain('情绪标注');
  });

  it('画像这一版有真消费者，所以 userModelEnabled 继续摆', () => {
    expect(PANEL_CODE).toContain('userModelEnabled');
  });

  it('改正文不带来源编辑入口：来源是确认那一刻的依据，不跟着正文改', () => {
    // 只看 PATCH 的请求体（POST 那扇门锁的是确认那一刻，来源本来就要递上去）。
    const patchBodies = [...PANEL.matchAll(/method:\s*'PATCH',\s*json:\s*\{([^}]*)\}/g)]
      .map((match) => match[1].trim())
      .sort();
    expect(patchBodies.filter((body) => body.includes('content'))).toEqual(['content']);
    for (const body of patchBodies) {
      expect(body).not.toContain('sourceMemoryIds');
      expect(body).not.toContain('sourceReflectionIds');
    }
  });

  it('候选只有「收进画像」一个动作：服务层没有「拒绝候选」的写入口，界面就不摆', () => {
    expect(PANEL_CODE).not.toContain('拒绝候选');
    expect(PANEL_CODE).toContain("method: 'POST'");
    expect(PANEL_CODE).toMatch(/method:\s*'PATCH',\s*json:\s*\{\s*content\s*\}/);
  });

  it('策略面板的画像控件两句话', () => {
    expect(POLICY_PANEL).toContain('允许把这种情境整理进画像');
    expect(POLICY_PANEL).toContain('关掉后，这种情境里记下的内容不再作为画像候选的依据。');
  });
});

describe('闸门与日志口径', () => {
  it('开关没打开就一个请求都不发（这一屏读的是密文）', () => {
    expect(PANEL).toContain('if (enabled === true) void load();');
  });

  it('画像正文不进日志：这个文件里没有 console', () => {
    expect(PANEL_CODE).not.toContain('console.');
  });

  it('日期不许在界面里自己拼：口径只有 user-profile-display 一处', () => {
    expect(PANEL_CODE).not.toMatch(/getUTCFullYear/);
    expect(PANEL_CODE).not.toMatch(/new Date\(/);
  });
});

describe('客户端包边界', () => {
  it('面板只许引用 user-profile-display，不许把带 prisma 的服务端模块拖进浏览器包', () => {
    const specifiers = [...PANEL.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers).toContain('@/lib/cognitive/user-profile-display');
    expect(specifiers.filter((name) => name.startsWith('@/lib/cognitive/'))).toEqual([
      '@/lib/cognitive/user-profile-display'
    ]);
    expect(specifiers).not.toContain('@prisma/client');
  });

  it('三行数字不许从服务端抄：条数上限由服务层拿，界面只说服务端说过的那句', () => {
    // 6 这个数字住在 user-model-module.ts，界面写的是同一句话里的字面量——两边各钉一次，改了任何一边都会红。
    expect(read('src/lib/cognitive/user-model-module.ts')).toContain('USER_MODEL_MAX_ITEMS = 6');
    expect(PANEL).toContain('最近 6 条');
  });
});

describe('设置页接线', () => {
  it('tab 三处都到位：导航项、渲染分支、Tab 联合类型', () => {
    expect(WORKSPACE).toContain("['userModel', '画像', Fingerprint]");
    expect(WORKSPACE).toContain("{tab === 'userModel' ? <ProfilePanel /> : null}");
    expect(WORKSPACE).toContain("'userModel'");
  });

  it('不复用「个人资料」那个 tab 的键：两个「画像」在同一个导航里会撞车', () => {
    expect(WORKSPACE).toContain("['profile', '个人资料', UserRound]");
    expect(WORKSPACE).not.toContain("['profile', '画像'");
  });
});
