import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「记忆策略」那一屏的静态断言（片 k）。
 *
 * 为什么是静态断言：这个项目没有组件测试、没有 jsdom，JSX 里的 div 和 onClick 跑不起来。
 * 所以这一屏能真验的只有两件事，都用读源码的方式验：
 * 一、**界面里不许出现过期的话**。这一屏的尾段曾经写着「『关联』一列至今没有运行时代码读它」，
 *    片 j 之后那句话就变成了假话——而它是用户看得见的正文，不是注释。这类句子必须有用例盯着。
 * 二、**控件不许骗人**。第八个开关的提示句要说清它挡什么、不挡什么；数字不许写死在文案里；
 *    读不到状态时不许替用户猜一个值并把控件点亮。
 *
 * 界面本身（像素、点击、真数据下的排布）**不在这里验收**，报告里明说它是无法验收项。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/** 注释里正是解释禁令的地方，「不许出现某句话」这类断言要在去掉注释的源码上跑。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL_RAW = read('src/components/settings/memory-policy-panel.tsx');
const PANEL = stripComments(PANEL_RAW);

describe('记忆策略一屏：不许说过期的话', () => {
  it('尾段那句「关联一列至今没有运行时代码读它」必须消失——片 j 之后它是假话', () => {
    expect(PANEL).not.toContain('至今没有运行时代码读它');
    // 消失不是删掉就完：同一处必须给出今天的事实，而且三列各自挡住什么都要说全。
    expect(PANEL).toContain('不放开联想，它就不和别的记忆连关联线');
  });

  it('仍然没有消费者的只剩情绪总开关，这一句要留着', () => {
    expect(PANEL).toContain('情绪总开关');
    // 界面不许摆一个没人读的旋钮：这条禁令由代码里不出现那个字段名来守（同片 d 的 P12）。
    expect(PANEL).not.toContain('emotionEnabled');
  });
});

describe('记忆策略一屏：第八个开关的控件', () => {
  it('有控件，读的是偏好接口里那一个值，写的也只那一个键', () => {
    expect(PANEL).toContain('preferences.adaptiveMemoryEnabled');
    expect(PANEL).toContain('checked={learning === true}');
    expect(PANEL).toContain('json: { adaptiveMemoryEnabled: next }');
  });

  it('读它不额外发一次请求：偏好那一读仍然只有一个 apiFetch，两个值同一次带回', () => {
    const loader = PANEL.match(/async function loadPreferences\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(loader).not.toBe('');
    expect(loader.match(/apiFetch</g)?.length).toBe(1);
    expect(loader).toContain('data.preferences.emotionTransparency');
    expect(loader).toContain('data.preferences.adaptiveMemoryEnabled');
  });

  it('开关状态没读到时代面不许猜，也不许点', () => {
    expect(PANEL).toContain('disabled={learning === null');
    expect(PANEL).toContain('这里不替你猜');
  });

  it('提示句同时说出「不再攒证据」和「派生清理一条都不少」——只说前半句就是骗人', () => {
    expect(PANEL).toContain('关掉后，永久删除和拒绝候选不再攒学习证据');
    expect(PANEL).toContain('删除本身的派生清理一条都不少');
  });

  /**
   * 片M 之后「算证据」的动作多了一个：对着一条待确认候选说「不要记」。
   * 它和永久删除说的是同一句话（任务书 1.3），所以这一屏只写「永久删除」就成了过期口径——
   * 用户会以为拒绝候选不影响策略，实际上它正在攒证据。
   */
  it('证据范围要说全：删除和拒绝都算，撤回、编辑、清空、确认都不算', () => {
    expect(PANEL).toContain('允许系统从你的删除和拒绝里学习');
    expect(PANEL).toContain('只有永久删除和拒绝候选算证据');
    expect(PANEL).toContain('确认候选都不算');
    expect(PANEL).not.toContain('只有永久删除算证据');
  });

  it('阈值和窗口天数都跟着接口走：界面里不许出现写死的次数或天数', () => {
    expect(PANEL).toContain('{threshold}');
    expect(PANEL).toContain('{windowDays}');
    expect(PANEL).not.toMatch(/\b3 次/);
    expect(PANEL).not.toMatch(/\b30 天/);
  });

  it('接口的两个常量真的被读进状态：只在 JSX 里插值、loader 里摆一个写死的数，同样是一句假话', () => {
    const policiesLoader = PANEL.match(/const load = useCallback[\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
    expect(policiesLoader).not.toBe('');
    expect(policiesLoader).toContain('setWindowDays(data.learningWindowDays)');
    expect(policiesLoader).toContain('setThreshold(data.learningThreshold)');
  });

  it('三条实际效果逐条写全，而且只写服务端真做了的那三件', () => {
    expect(PANEL).toContain('撤回、编辑记忆、清空全部长期记忆、确认候选都不算');
    expect(PANEL).toContain('学习只会更保守，不会放松任何一列');
    expect(PANEL).toContain('你手动改过的情境归你管');
    expect(PANEL).toContain('攒下的证据也一起清掉');
  });

  it('这一档和七张卡管的是两件事，界面必须把这层分开说出来', () => {
    expect(PANEL).toContain('系统能不能替你改策略');
  });
});
