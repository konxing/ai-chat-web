import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '@/lib/crypto';
import { readDecisionContext } from '@/lib/cognitive/decisions';

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  findManyWhere: null as Record<string, unknown> | null,
  findManyTake: null as number | null
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    decisionRecord: {
      findMany: (args: { where?: Record<string, unknown>; take?: number }) => {
        db.findManyWhere = args.where ?? {};
        db.findManyTake = args.take ?? null;
        return Promise.resolve(
          db.rows.filter((row) =>
            Object.entries(args.where ?? {}).every(([key, value]) => row[key] === value)
          )
        );
      }
    }
  }
}));

const aad = (id: string, field: string) => `decision:v1:user-a:${id}:${field}`;

function decision(id: string, status: string, topic: string, choice: string) {
  return {
    id,
    userId: 'user-a',
    status,
    topicCiphertext: encryptString(topic, aad(id, 'topic')),
    choiceCiphertext: encryptString(choice, aad(id, 'choice')),
    decidedAt: new Date('2026-10-01T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z')
  };
}

const CORPUS = [
  decision('d1', 'CONFIRMED', '买一台二手笔记本，预算六千', '选了 ThinkPad T14'),
  decision('d2', 'CONFIRMED', '数据库用 PostgreSQL，不上 MySQL', '迁到 PostgreSQL 17'),
  decision('d3', 'CONFIRMED', '打算跳槽去一家做基础设施的公司', '接了基础设施组的 offer'),
  decision('d4', 'PENDING_CONFIRM', '买一台二手显示器', '还没确认')
];

describe('决策经验读侧（5-E）', () => {
  beforeEach(() => {
    db.rows = CORPUS.map((row) => ({ ...row }));
    db.findManyWhere = null;
    db.findManyTake = null;
  });

  it('只拿已确认的决策，且有池子上限', async () => {
    await readDecisionContext({ userId: 'user-a', query: '笔记本买哪种好' });
    expect(db.findManyWhere).toMatchObject({ userId: 'user-a', status: 'CONFIRMED' });
    expect(db.findManyTake).toBeTypeOf('number');
  });

  it('主题重合的决策进上下文，并带着「不要照搬」的措辞', async () => {
    const blocks = await readDecisionContext({ userId: 'user-a', query: '再买一台笔记本要注意什么' });
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.module).toBe('decisionMemory');
    expect(block.text).toContain('需结合当前约束重新分析');
    expect(block.text).toContain('买一台二手笔记本，预算六千');
    expect(block.text).not.toContain('跳槽');
  });

  it('零共同词的问句一条都不注入', async () => {
    const blocks = await readDecisionContext({ userId: 'user-a', query: '今天天气怎么样' });
    expect(blocks).toHaveLength(0);
  });

  it('最多两条，按重合度排', async () => {
    const blocks = await readDecisionContext({
      userId: 'user-a',
      query: '笔记本和数据库这两件事后来怎么定的'
    });
    const lines = blocks[0]!.text.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(2);
  });

  it('字符预算超了就不给，不把提示词撑爆', async () => {
    db.rows = [
      decision('e1', 'CONFIRMED', '笔记本预算六千', '甲'),
      decision('e2', 'CONFIRMED', '笔记本要轻薄', '乙'.padEnd(900, '乙'))
    ];
    const blocks = await readDecisionContext({ userId: 'user-a', query: '笔记本怎么挑' });
    const lines = blocks[0]!.text.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(1);
  });

  it('没有查询词就不读库', async () => {
    const blocks = await readDecisionContext({ userId: 'user-a', query: '' });
    expect(blocks).toHaveLength(0);
    expect(db.findManyWhere).toBeNull();
  });
});

/**
 * 召回探针：四条决策、四类问法。钉的是「该连的连上、不该连的一个不连」，
 * 这是 7.2 D 臂的部分覆盖——完整 D 臂要等评测语料带上决策字段，那片还没做。
 */
describe('决策召回探针', () => {
  beforeEach(() => {
    db.rows = CORPUS.map((row) => ({ ...row }));
  });

  const probes: Array<[string, string[]]> = [
    ['买笔记本预算怎么定', ['d1']],
    ['数据库选 MySQL 还是别的', ['d2']],
    ['换工作的事有进展吗', []],
    ['去基础设施公司的事有进展吗', ['d3']],
    ['周末去哪玩', []]
  ];

  for (const [query, expected] of probes) {
    it(`「${query}」召回 ${expected.length === 0 ? '空' : expected.join(',')}`, async () => {
      const blocks = await readDecisionContext({ userId: 'user-a', query });
      const text = blocks.map((block) => block.text).join('\n');
      const hit = expected
        .map((id) => CORPUS.find((row) => row.id === id)!)
        .every((row) => text.includes(decryptTopic(row.id, row.topicCiphertext as string)));
      const miss = CORPUS.filter((row) => !expected.includes(row.id as string)).every(
        (row) => !text.includes(decryptTopic(row.id, row.topicCiphertext as string))
      );
      expect(hit && miss, query).toBe(true);
    });
  }
});

function decryptTopic(id: string, ciphertext: string): string {
  return decryptString(ciphertext, aad(id, 'topic'));
}
