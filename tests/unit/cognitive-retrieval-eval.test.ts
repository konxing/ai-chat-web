import { describe, expect, it } from 'vitest';
import { rankMemories } from '@/lib/cognitive/retrieval';

/**
 * 检索基线对照（任务书 7.2 的 A/B、7.4 末段「没有实测收益的模块不应默认启用」）。
 *
 * A = 改造前的行为：按 recordedAt 倒序取前 K 条。
 * B = 现在的行为：关键词召回。
 * 判据有两条，缺一不可——B 的平均 Recall@K 必须高于 A，而且逐条查询都不许比 A 差。
 * 只满足第一条是不够的：靠在某几条上大赢、在另几条上悄悄变差，用户是感知得到的。
 *
 * 数据全是编的（任务书 7.1 明令禁止拿真实聊天记录当测试集），
 * 每个故事 12 条记忆：10 条近期日常 + 1 条近期相关 + 1 条很久以前的相关。
 * 后半是刻意安排的：按时间取前 8 条一定捞不到它，这正是改造前那个病根。
 *
 * 这不是任务书 7.1 要求的完整 Harness（30 个故事 × 6～10 个会话 + 人工标准答案），
 * 只是第一块砖：先把「增强必须优于基线」这条门槛变成可执行的断言。
 */

const K = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 与查询无关的日常内容。每个故事共用一批，省得把 fixture 写成一本日记。 */
const FILLERS = [
  '今天开了个例会',
  '午饭吃的面条',
  '这周下雨了三天',
  '我把桌面收拾了一遍',
  '周末睡了个懒觉',
  '地铁上人多得离谱',
  '我换了一个新杯子',
  '晚上看了部电影',
  '快递昨天到了',
  '阳台的花该浇水了'
];

interface Story {
  name: string;
  /** 近期那条相关记忆：基线也能捞到，用来钉「不许变差」。 */
  recent: [string, string];
  /** 很久以前那条：基线一定捞不到，用来钉「确实有收益」。 */
  old: [string, string, number];
  recentQuery: [string, string];
  oldQuery: [string, string];
}

const STORIES: Story[] = [
  {
    name: '数据库选型',
    recent: ['s1-new', '项目 A 现在用 PostgreSQL'],
    old: ['s1-old', '项目 A 最早是用 MySQL 的', 210],
    recentQuery: ['项目 A 现在用什么数据库', 's1-new'],
    oldQuery: ['项目 A 最早用的是哪种数据库', 's1-old']
  },
  {
    name: '证书目标',
    recent: ['s2-new', '我打算今年考 PMP'],
    old: ['s2-old', '我三年前考过雅思', 900],
    recentQuery: ['我今年打算考什么', 's2-new'],
    oldQuery: ['我以前考过什么英语考试', 's2-old']
  },
  {
    name: '乐器',
    recent: ['s3-new', '我最近又在练吉他'],
    old: ['s3-old', '我小时候学过小提琴', 1500],
    recentQuery: ['我乐器最近在练什么', 's3-new'],
    oldQuery: ['我小时候学过什么乐器', 's3-old']
  },
  {
    name: '服务器决策',
    recent: ['s4-new', '服务器最后决定不买那台了'],
    old: ['s4-old', '当初考虑过自建机房', 400],
    recentQuery: ['服务器最后买了吗', 's4-new'],
    oldQuery: ['当初有没有考虑自建机房', 's4-old']
  },
  {
    name: '药物过敏',
    recent: ['s5-new', '我上周感冒吃了点药'],
    old: ['s5-old', '我对青霉素过敏', 700],
    recentQuery: ['我上周身体怎么了', 's5-new'],
    oldQuery: ['我有什么药物过敏', 's5-old']
  },
  {
    name: '同事分工',
    recent: ['s6-new', '老周这周休假'],
    old: ['s6-old', '老周是负责后端的同事', 300],
    recentQuery: ['老周这周在不在', 's6-new'],
    oldQuery: ['老周负责哪一块', 's6-old']
  }
];

interface Row {
  story: string;
  kind: 'recent' | 'old';
  query: string;
  baseline: number;
  keyword: number;
}

function poolOf(story: Story) {
  const memories = [
    { id: story.recent[0], content: story.recent[1], daysAgo: 1 },
    { id: story.old[0], content: story.old[1], daysAgo: story.old[2] },
    ...FILLERS.map((content, index) => ({ id: `${story.name}-filler-${index}`, content, daysAgo: index + 2 }))
  ];
  // listMemories 给的就是 recordedAt 倒序，这里按同一形状排。
  return memories
    .sort((left, right) => left.daysAgo - right.daysAgo)
    .map((memory) => ({
      id: memory.id,
      content: memory.content,
      recordedAt: new Date(Date.now() - memory.daysAgo * DAY_MS).toISOString()
    }));
}

/** A：改造前的行为，就是「最近 K 条」。 */
function baselineRetrieve(pool: ReturnType<typeof poolOf>): string[] {
  return pool.slice(0, K).map((memory) => memory.id);
}

function keywordRetrieve(pool: ReturnType<typeof poolOf>, query: string): string[] {
  return rankMemories(query, pool, { limit: K }).map((memory) => memory.id);
}

function recall(retrieved: string[], expected: string): number {
  return retrieved.includes(expected) ? 1 : 0;
}

function evaluate(): Row[] {
  const rows: Row[] = [];
  for (const story of STORIES) {
    const pool = poolOf(story);
    for (const [kind, [query, expected]] of [
      ['recent', story.recentQuery],
      ['old', story.oldQuery]
    ] as Array<['recent' | 'old', [string, string]]>) {
      rows.push({
        story: story.name,
        kind,
        query,
        baseline: recall(baselineRetrieve(pool), expected),
        keyword: recall(keywordRetrieve(pool, query), expected)
      });
    }
  }
  return rows;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const rows = evaluate();
const recentRows = rows.filter((row) => row.kind === 'recent');
const oldRows = rows.filter((row) => row.kind === 'old');

describe('检索基线对照（Recall@8）', () => {
  it('关键词召回的整体召回率高于按时间取前 8 条', () => {
    expect(mean(rows.map((row) => row.baseline))).toBeLessThan(mean(rows.map((row) => row.keyword)));
  });

  it('逐条查询都不许比基线差——不许靠几条大赢掩盖另几条变差', () => {
    const regressions = rows
      .filter((row) => row.keyword < row.baseline)
      .map((row) => `${row.story}｜${row.query}｜baseline=${row.baseline} keyword=${row.keyword}`);

    expect(regressions).toEqual([]);
  });

  it('基线在「很久以前那条」上确实会漏，这个对照不是空跑', () => {
    expect(mean(oldRows.map((row) => row.baseline))).toBeLessThan(0.5);
    expect(mean(oldRows.map((row) => row.keyword))).toBe(1);
  });

  it('基线能捞到的近期记忆，关键词召回也一条不漏', () => {
    expect(mean(recentRows.map((row) => row.keyword))).toBe(1);
  });

  it('每个故事的池子都是 12 条，K=8 时基线必然漏掉最旧的 4 条', () => {
    for (const story of STORIES) {
      expect(poolOf(story)).toHaveLength(12);
    }
    expect(K).toBeLessThan(12);
  });
});
