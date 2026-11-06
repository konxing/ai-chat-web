import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryDto } from '@/lib/cognitive/memories';
import type { MemoryPolicy } from '@/lib/cognitive/policy';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';

/**
 * 片O：记忆关系与两跳扩展。
 *
 * 这里钉的是任务书 2.3 / 3.2 的四个硬约束：
 * 一、系统只自动建两种有确定证据的边（演化、同主题），因果边没有自动入口；
 * 二、扩展最多两跳、最多 30 个候选、最多注入 8 条；
 * 三、目标必须仍在可见池、通过保留期与情境策略，且该情境允许关联；
 * 四、跨用户查询永远带 userId，别人的边一条也读不到。
 *
 * 数据库用最小替身：只实现 relations.ts 真正用到的算子（upsert / findMany + OR/in/gte）。
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  edges: [] as Row[],
  upserts: [] as Row[],
  queries: [] as unknown[]
}));

function matchesEdge(row: Row, where: Row): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  const confidence = where.confidence as { gte?: number } | undefined;
  if (confidence?.gte !== undefined && (row.confidence as number) < confidence.gte) return false;
  const or = where.OR as Array<Row> | undefined;
  if (or) {
    return or.some((branch) => {
      const source = branch.sourceMemoryId as { in?: string[] } | undefined;
      if (source?.in) return source.in.includes(row.sourceMemoryId as string);
      const target = branch.targetMemoryId as { in?: string[] } | undefined;
      if (target?.in) return target.in.includes(row.targetMemoryId as string);
      return false;
    });
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    memoryRelation: {
      upsert: ({
        where,
        create,
        update
      }: {
        where: { userId_sourceMemoryId_targetMemoryId_relationType: Row };
        create: Row;
        update: Row;
      }) => {
        db.upserts.push({ key: where.userId_sourceMemoryId_targetMemoryId_relationType, create, update });
        const key = where.userId_sourceMemoryId_targetMemoryId_relationType;
        const existing = db.edges.find(
          (row) =>
            row.userId === key.userId &&
            row.sourceMemoryId === key.sourceMemoryId &&
            row.targetMemoryId === key.targetMemoryId &&
            row.relationType === key.relationType
        );
        if (existing) Object.assign(existing, update);
        else db.edges.push({ id: `rel-${db.edges.length + 1}`, ...create });
        return Promise.resolve(existing ?? db.edges[db.edges.length - 1]);
      },
      findMany: ({ where, orderBy }: { where: Row; orderBy?: Array<Row> }) => {
        db.queries.push(where);
        const rows = db.edges.filter((row) => matchesEdge(row, where));
        const first = orderBy?.[0] as Record<string, string> | undefined;
        if (first?.confidence === 'desc') {
          rows.sort((left, right) => (right.confidence as number) - (left.confidence as number));
        }
        return Promise.resolve(rows);
      }
    }
  }
}));

const {
  expandRelatedMemories,
  recordEvolutionRelation,
  recordTopicRelations,
  GRAPH_MAX_INJECTED
} = await import('@/lib/cognitive/relations');
const { renderMemoryBlock, MEMORY_READ_MAX_CHARS } = await import('@/lib/cognitive/memory-module');

function memory(overrides: Partial<MemoryDto> & { id: string }): MemoryDto {
  return {
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    content: '周末去爬山',
    confirmedAt: '2026-10-01T00:00:00.000Z',
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  };
}

function edge(overrides: Partial<Row> & { id: string }): Row {
  return {
    userId: 'user-1',
    sourceMemoryId: 'seed',
    targetMemoryId: 'target',
    relationType: 'SAME_TOPIC',
    confidence: 0.8,
    origin: 'SYSTEM',
    status: 'ACTIVE',
    evidenceIds: [],
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides
  };
}

const POLICIES = { ...DEFAULT_MEMORY_POLICIES } as Record<string, MemoryPolicy>;
const NOW = new Date('2026-11-03T00:00:00.000Z');

beforeEach(() => {
  db.edges = [];
  db.upserts = [];
  db.queries = [];
});

describe('写侧：只建两种有确定证据的边', () => {
  it('演化边写成 EVOLVES_FROM，证据就是那条 revision，置信度 1', async () => {
    await recordEvolutionRelation(
      { memoryRelation: { upsert: (await import('@/lib/prisma')).prisma.memoryRelation.upsert } } as never,
      { userId: 'user-1', newMemoryId: 'new', previousMemoryId: 'old', revisionId: 'rev-1' }
    );

    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]!.create).toMatchObject({
      userId: 'user-1',
      sourceMemoryId: 'new',
      targetMemoryId: 'old',
      relationType: 'EVOLVES_FROM',
      confidence: 1,
      evidenceIds: ['rev-1']
    });
  });

  it('同主题边最多连三条，只连同情境且重合至少两个词的行', async () => {
    await recordTopicRelations(
      { memoryRelation: { upsert: (await import('@/lib/prisma')).prisma.memoryRelation.upsert } } as never,
      {
        userId: 'user-1',
        memoryId: 'new',
        content: '下周末还想去爬山',
        context: 'general',
        sourceMessageId: 'msg-9',
        existing: [
          memory({ id: 'a', content: '周末去爬山' }),
          memory({ id: 'b', content: '周末爬山带了相机' }),
          memory({ id: 'c', content: '周末爬山要看天气' }),
          memory({ id: 'd', content: '周末爬山要早起' }),
          memory({ id: 'e', content: '周末去爬山', context: 'learning' }),
          memory({ id: 'f', content: '今天买了咖啡' })
        ]
      }
    );

    expect(db.upserts).toHaveLength(3);
    for (const write of db.upserts) {
      expect(write.create).toMatchObject({
        relationType: 'SAME_TOPIC',
        sourceMemoryId: 'new'
      });
      expect((write.create as Row).targetMemoryId).not.toBe('e');
      expect((write.create as Row).targetMemoryId).not.toBe('f');
    }
  });

  it('没有来源消息时，同主题边的置信度封顶 0.5、证据为空', async () => {
    await recordTopicRelations(
      { memoryRelation: { upsert: (await import('@/lib/prisma')).prisma.memoryRelation.upsert } } as never,
      {
        userId: 'user-1',
        memoryId: 'new',
        content: '周末去爬山',
        context: 'general',
        sourceMessageId: null,
        existing: [memory({ id: 'a', content: '周末爬山很累' })]
      }
    );

    expect(db.upserts[0]!.create).toMatchObject({ confidence: 0.5, evidenceIds: [] });
  });
});

describe('读侧：两跳扩展的四道限制', () => {
  const seeds = [memory({ id: 'seed', content: '周末去爬山' })];
  const pool = [
    seeds[0]!,
    memory({ id: 'hop1', content: '爬山要带相机' }),
    memory({ id: 'hop2', content: '相机是去年买的' }),
    memory({ id: 'hop3', content: '去年买了很多东西' })
  ];

  function run(overrides: Partial<Parameters<typeof expandRelatedMemories>[0]> = {}) {
    return expandRelatedMemories({
      userId: 'user-1',
      seeds,
      rows: pool,
      policies: POLICIES,
      chatId: 'chat-1',
      now: NOW,
      ...overrides
    });
  }

  it('只走两跳：第三跳上的行不会被注入', async () => {
    db.edges = [
      edge({ id: 'r1', sourceMemoryId: 'seed', targetMemoryId: 'hop1' }),
      edge({ id: 'r2', sourceMemoryId: 'hop1', targetMemoryId: 'hop2' }),
      edge({ id: 'r3', sourceMemoryId: 'hop2', targetMemoryId: 'hop3' })
    ];

    const hits = await run();

    expect(hits.map((hit) => hit.memory.id)).toEqual(['hop1', 'hop2']);
    expect(hits.map((hit) => hit.hop)).toEqual([1, 2]);
  });

  it('情境策略关掉关联时，那个情境的种子不扩、目标也不进', async () => {
    db.edges = [edge({ id: 'r1' })];
    const policies: Record<string, MemoryPolicy> = {
      ...POLICIES,
      general: { ...POLICIES.general!, allowAssociation: false }
    };

    expect(await run({ policies })).toEqual([]);
  });

  it('目标不在可见池、或已被保留期挡掉时一条都不给', async () => {
    db.edges = [
      edge({ id: 'r1', targetMemoryId: 'missing' }),
      edge({ id: 'r2', targetMemoryId: 'expired' })
    ];

    const sessionPolicies: Record<string, MemoryPolicy> = {
        ...POLICIES,
        emotionalSupport: { ...POLICIES.emotionalSupport!, retention: 'sessionOnly' }
      };

    const hits = await run({
      rows: [
        ...pool,
        memory({
          id: 'expired',
          content: '过期的事',
          context: 'emotionalSupport'
        })
      ],
      policies: sessionPolicies,
      chatId: 'chat-other'
    });

    expect(hits).toEqual([]);
  });

  it('情绪总开关关着时，情绪类目标不进上下文', async () => {
    db.edges = [edge({ id: 'r1', targetMemoryId: 'mood' })];
    const hits = await run({
      rows: [...pool, memory({ id: 'mood', type: 'emotion', content: '那天很开心' })],
      emotionEnabled: false
    });

    expect(hits).toEqual([]);
  });

  it('最多注入 8 条，且查询永远带着 userId 与 ACTIVE', async () => {
    db.edges = Array.from({ length: 12 }, (_, index) =>
      edge({ id: `r${index}`, targetMemoryId: `t${index}` })
    );
    const rows = [
      ...pool,
      ...Array.from({ length: 12 }, (_, index) => memory({ id: `t${index}`, content: `关联 ${index}` }))
    ];

    const hits = await run({ rows });

    expect(hits).toHaveLength(GRAPH_MAX_INJECTED);
    for (const query of db.queries) {
      expect(query).toMatchObject({ userId: 'user-1', status: 'ACTIVE' });
      expect((query as Row).confidence).toMatchObject({ gte: 0.5 });
    }
  });

  it('低置信度的边不参与扩展', async () => {
    db.edges = [edge({ id: 'weak', targetMemoryId: 'hop1', confidence: 0.49 })];

    expect(await run()).toEqual([]);
  });
});
describe('渲染：关联行和种子共用同一个字符预算', () => {
  const seed = memory({ id: 'seed', content: '周末去爬山' });
  const related = [
    {
      memory: memory({ id: 'hop1', content: '爬山要带相机' }),
      hop: 1,
      relationType: 'SAME_TOPIC' as const,
      viaMemoryId: 'seed',
      viaSnippet: '周末去爬山'
    }
  ];

  it('关联行写进同一个块，并进引用清单', () => {
    const blocks = renderMemoryBlock([seed], new Map(), 'implicit', related);

    expect(blocks[0]!.text).toContain('相关记忆');
    expect(blocks[0]!.text).toContain('同主题');
    expect(blocks[0]!.memoryIds).toEqual(['seed', 'hop1']);
  });

  it('预算放不下时一条关联行都不写，也不谎报引用', () => {
    // 先量出一行记忆除了正文之外还要占多少字符，再把正文填到只剩 5 个字符——
    // 留不出「相关记忆」那行抬头的位子，于是关联行必须整段缺席。
    const probe = renderMemoryBlock([memory({ id: 'seed', content: 'x' })], new Map(), 'implicit', []);
    const overhead = probe[0]!.text.length - 1;
    const long = memory({ id: 'seed', content: '长'.repeat(MEMORY_READ_MAX_CHARS - overhead - 5) });
    const blocks = renderMemoryBlock([long], new Map(), 'implicit', related);

    expect(blocks[0]!.text).not.toContain('相关记忆');
    expect(blocks[0]!.memoryIds).toEqual(['seed']);
  });
});
