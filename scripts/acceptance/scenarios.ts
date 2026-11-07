/**
 * 验收场景库与标准答案（验收总计划书第 5 章）。
 *
 * 铁律：**标准答案固定之后才能跑，跑了之后不许改这里。**
 * 哪条期望过不去，那是被测系统的缺陷，进缺陷清单（P0–P3），
 * 不是回来把这一行改绿。想修期望只能在一个情况下动：期望本身写错了
 * （比如记错了字段名），而且改动必须和「为什么之前写错」一起留在提交记录里。
 *
 * 判定一律看证据不看话术：assistant 说得再像记住了，
 * inspectVirtualUser 里没有那行记忆就是没记住。
 */

export interface ScenarioStep {
  /** 这一轮用户说的话；act 步骤不说。 */
  say?: string;
  /**
   * 用户的一次界面操作（不是说话）。forgetMemoriesContaining＝打开记忆面板，
   * 把正文含 match 的行逐条永久删除——和用户在那一屏点「删除」走同一批路由。
   */
  act?: { type: 'forgetMemoriesContaining'; match: string };
  /** 开一个新会话再说（跨会话回忆的关键动作）。 */
  newChat?: boolean;
  /** 说完之后等后台认知任务跑完再进入下一步。 */
  settle?: boolean;
  /** 模型回答里必须出现的子串（软判定，只用于回忆类探针）。 */
  assistantMustContain?: string[];
}

export interface ScenarioExpect {
  /** 解密后的记忆正文里必须出现的子串。 */
  memoriesMustContain?: string[];
  /** 解密后的记忆正文里不许出现的子串（活跃行，被取代/删除的不算）。 */
  activeMemoriesMustNotContain?: string[];
  /** 活跃记忆至少几条。 */
  activeMemoryCountMin?: number;
  /** 派生表行数下限：管线动没动的物证。 */
  countMin?: Partial<
    Record<
      | 'memoryRevision'
      | 'memoryCandidate'
      | 'decisionRecord'
      | 'reflectionRecord'
      | 'cognitiveTask',
      number
    >
  >;
}

export interface Scenario {
  id: string;
  title: string;
  /** 需要几个虚拟用户。 */
  users: number;
  steps: ScenarioStep[];
  expect: ScenarioExpect;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 's-smoke-01',
    title: '跨会话回忆：说过的偏好，换个会话被引用',
    users: 1,
    steps: [
      { say: '我喜欢喝黑咖啡，不加糖也不加奶。', settle: true },
      { say: '我在学 TypeScript，目标是今年能独立写后端服务。', settle: true },
      {
        say: '我喜欢喝什么样的咖啡？',
        newChat: true,
        assistantMustContain: ['黑咖啡']
      }
    ],
    expect: {
      memoriesMustContain: ['黑咖啡', 'TypeScript'],
      activeMemoryCountMin: 2
    }
  },
  {
    id: 's-smoke-02',
    title: '事实更新：改口之后新说法在场，旧说法不再活跃',
    users: 1,
    steps: [
      { say: '我现在每天早上跑步三公里。', settle: true },
      { say: '其实我不跑步了，膝盖不行，改成每天游泳了。', settle: true }
    ],
    expect: {
      memoriesMustContain: ['游泳'],
      activeMemoriesMustNotContain: ['跑步三公里'],
      countMin: { memoryRevision: 1 }
    }
  },
  {
    id: 's-smoke-03',
    title: '决策记忆：说出一个决定和它的理由，决策表要动',
    users: 1,
    steps: [
      {
        say: '我决定了，接受杭州那份工作 offer，因为薪资高了 40%，而且离家高铁只要一小时。',
        settle: true
      }
    ],
    expect: {
      countMin: { decisionRecord: 1 }
    }
  },
  {
    id: 's-smoke-04',
    title: '选择性遗忘：点名删掉之后，证据里查无此行',
    users: 1,
    steps: [
      { say: '我养了一只叫年糕的布偶猫。', settle: true },
      { act: { type: 'forgetMemoriesContaining', match: '年糕' }, settle: true }
    ],
    expect: {
      activeMemoriesMustNotContain: ['年糕', '布偶猫']
    }
  },
  {
    id: 's-smoke-05',
    title: '时间框架：上周发生的事，带着时间被记住',
    users: 1,
    steps: [
      { say: '上周三我去医院拔了智齿，到现在脸还有点肿。', settle: true }
    ],
    expect: {
      memoriesMustContain: ['智齿']
    }
  }
];

export function getScenario(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`场景不存在: ${id}`);
  return found;
}
