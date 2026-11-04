import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '@/lib/crypto';
import { tokenize } from '@/lib/cognitive/retrieval';
import { COUNTER_CLAUSE } from '@/lib/cognitive/reflection-evidence';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 6-D：反思生成落库（任务书 6.6 的冷却与限量、1.2 的逐情境闸门、7.4 的门槛 4/5/7/8）。
 *
 * 这一层是 6-B 的规则、6-C 的证据与措辞**第一次真的往库里写东西**，所以钉的全是写入口的纪律：
 * 一、冷却先读开关再抢戳。开关关着的用户不该被盖上一个时间戳——否则他 later 打开开关，
 *    还要为一次根本没跑过的扫描等满一天。
 * 二、抢戳是条件 UPDATE，NULL 也算「没扫过」。SQL 里 `null < x` 不成立，漏掉那一半
 *    就等于第一次扫描永远排不上。
 * 三、逐情境闸门在措辞之前、落库之默认档：`personalReflection` 与 `emotionalSupport`
 *    的 allowReflection 内置为 false，所以引用了那两个情境的洞察整条不落地。
 * 四、一行洞察 + 它的引用行必须同用户、同事务，且引用恰好指到真正读过的那几行
 *    （决策证据也算读过——poolIds 漏掉决策 id，critic 会把每条 DECISION_LESSON 判成幽灵引用）。
 * 五、日志只有 id、类型和计数。正文是用户的原话，一次都不许进日志。
 *
 * 边界：跑的是内存求值器不是 SQL。条件 UPDATE 的行锁、真库唯一约束、事务回滚
 * 都不在本文件的证明范围（同样的口径写在 cognitive-task-worker.test.ts 头部）。
 */

const ctx = vi.hoisted(() => ({
  events: [] as Array<[string, Record<string, unknown>]>
}));

const tables = new Map<string, MockTable>();

function named(name: string, build: () => MockTable): MockTable {
  let table = tables.get(name);
  if (!table) {
    table = build();
    tables.set(name, table);
  }
  return table;
}

const USER = 'user-a';
const OTHER = 'user-b';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY = 86_400_000;

function buildTables() {
  return {
    cognitivePreference: named('cognitivePreference', () =>
      createTable({
        idField: 'userId',
        defaults: () => ({ reflectionSweptAt: null })
      })
    ),
    memoryPolicy: named('memoryPolicy', () => createTable({ idField: 'context' })),
    memoryItem: named('memoryItem', () => createTable()),
    memoryRevision: named('memoryRevision', () => createTable()),
    decisionRecord: named('decisionRecord', () => createTable()),
    decisionOutcome: named('decisionOutcome', () => createTable()),
    reflectionRecord: named('reflectionRecord', () =>
      createTable({
        unique: [['userId', 'dedupKey']],
        defaults: () => ({ status: 'PENDING' })
      })
    ),
    reflectionCitation: named('reflectionCitation', () => createTable())
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    get cognitivePreference() {
      return buildTables().cognitivePreference;
    },
    get memoryPolicy() {
      return buildTables().memoryPolicy;
    },
    get memoryItem() {
      return buildTables().memoryItem;
    },
    get memoryRevision() {
      return buildTables().memoryRevision;
    },
    get decisionRecord() {
      return buildTables().decisionRecord;
    },
    get decisionOutcome() {
      return buildTables().decisionOutcome;
    },
    get reflectionRecord() {
      return buildTables().reflectionRecord;
    },
    get reflectionCitation() {
      return buildTables().reflectionCitation;
    },
    // 引用行跟着洞察行走同一个回调：这里的形状只证明「一次调用写两类行」，
    // 真库的回滚不在内存求值器的证明范围。
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(buildTables())
  }
}));

vi.mock('@/lib/logger', () => ({
  log: {
    debug: (event: string, fields: Record<string, unknown>) => ctx.events.push([event, fields]),
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown>) => ctx.events.push([event, fields]),
    error: (event: string, fields: Record<string, unknown>) => ctx.events.push([event, fields])
  }
}));

async function sweep(userId = USER, now = NOW) {
  const module = await import('@/lib/cognitive/reflection-sweep');
  return module.runReflectionSweep(userId, { now });
}

function reflectionSweepConstants() {
  return import('@/lib/cognitive/reflection-sweep');
}

/** 开关：只有 reflectionEnabled 那一档和这一片有关，其余按库里的默认全关。 */
function switchOn(userId = USER, sweptAt: Date | null = null) {
  tables.get('cognitivePreference')!.seed({
    userId,
    memoryEnabled: false,
    userModelEnabled: false,
    emotionEnabled: false,
    associationEnabled: false,
    timelineEnabled: false,
    reflectionEnabled: true,
    decisionMemoryEnabled: false,
    adaptiveMemoryEnabled: false,
    emotionTransparency: 'IMPLICIT',
    reflectionSweptAt: sweptAt,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW)
  });
}

/** 记忆行：正文按真库的 AAD 加密，所以走的是真实解密路径。 */
function memory(
  id: string,
  text: string,
  overrides: Partial<Record<string, unknown>> = {},
  userId = USER
) {
  tables.get('memoryItem')!.seed({
    id,
    userId,
    chatId: overrides.chatId === undefined ? `chat-${id}` : overrides.chatId,
    sourceMessageId: null,
    type: 'FACT',
    context: 'GENERAL',
    origin: 'EXPLICIT',
    contentCiphertext: encryptString(text, `memory:v1:${userId}:${id}`),
    embeddingCiphertext: null,
    embeddingModel: null,
    confirmedAt: null,
    version: 1,
    supersededAt: null,
    validFrom: null,
    validTo: null,
    validPrecision: 'UNKNOWN',
    recordedAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides
  });
}

function decision(
  id: string,
  topic: string,
  overrides: Partial<Record<string, unknown>> = {},
  userId = USER
) {
  const aad = (field: string) => `decision:v1:${userId}:${id}:${field}`;
  tables.get('decisionRecord')!.seed({
    id,
    userId,
    category: 'TECH_CHOICE',
    status: 'CONFIRMED',
    topicCiphertext: encryptString(topic, aad('topic')),
    choiceCiphertext: encryptString(topic, aad('choice')),
    backgroundCiphertext: null,
    constraintsCiphertext: null,
    optionsCiphertext: null,
    reasonCiphertext: null,
    criteriaCiphertext: null,
    expectedOutcomeCiphertext: null,
    risksCiphertext: null,
    decidedAt: null,
    reviewAfter: null,
    confirmedAt: new Date(NOW),
    sourceMessageId: `msg-${id}`,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides
  });
}

function outcomeRow(decisionId: string, recordedAt: Date, userId = USER) {
  tables.get('decisionOutcome')!.seed({
    id: `out-${decisionId}-${recordedAt.getTime()}`,
    userId,
    decisionId,
    linkStatus: 'LINKED',
    actualCiphertext: encryptString('成了', `decision-outcome:v1:${userId}:x:actual`),
    recordedAt,
    sourceMessageId: 'msg-out'
  });
}

/** 两句互相打脸的最小池子：同一簇、一句带否定词。 */
function contradictionPool(userId = USER) {
  memory('m1', '周末去爬山', { recordedAt: new Date('2026-09-01T00:00:00Z'), chatId: 'c1' }, userId);
  memory('m2', '周末不去爬山', { recordedAt: new Date('2026-09-20T00:00:00Z'), chatId: 'c2' }, userId);
}

function writtenRecords(): Row[] {
  return [...tables.get('reflectionRecord')!.rows.values()];
}

function writtenCitations(): Row[] {
  return [...tables.get('reflectionCitation')!.rows.values()];
}

function bodyOf(row: Row): string {
  return decryptString(String(row.bodyCiphertext), `reflection:v1:${row.userId}:${row.id}:body`);
}

beforeEach(() => {
  tables.clear();
  ctx.events.length = 0;
  buildTables();
});

describe('冷却与开关', () => {
  it('reflectionEnabled 关着 ⇒ 什么都不做，也不给反思扫描盖时间戳', async () => {
    contradictionPool();
    tables.get('cognitivePreference')!.seed({ userId: USER, reflectionEnabled: false, reflectionSweptAt: null });

    const outcome = await sweep();

    expect(outcome.ran).toBe(false);
    expect(outcome.generated).toBe(0);
    expect(writtenRecords()).toEqual([]);
    expect(tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt).toBeNull();
  });

  it('从没扫过（reflectionSweptAt 为 NULL）⇒ 抢得到冷却，跑完把戳盖上', async () => {
    contradictionPool();
    switchOn();

    const outcome = await sweep();

    expect(outcome.ran).toBe(true);
    const stamped = tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt;
    expect(stamped).toBeInstanceOf(Date);
    expect((stamped as Date).getTime()).toBe(NOW.getTime());
  });

  it('23 小时前扫过 ⇒ 冷却没到，一条都不写', async () => {
    contradictionPool();
    switchOn(USER, new Date(NOW.getTime() - 23 * 3_600_000));

    const outcome = await sweep();

    expect(outcome.ran).toBe(false);
    expect(writtenRecords()).toEqual([]);
  });

  it('25 小时前扫过 ⇒ 冷却到期，可以再扫', async () => {
    contradictionPool();
    switchOn(USER, new Date(NOW.getTime() - 25 * 3_600_000));

    const outcome = await sweep();

    expect(outcome.ran).toBe(true);
    expect(writtenRecords()).toHaveLength(1);
  });

  it('偏好读不出来 ⇒ 不跑也不写，且不抛', async () => {
    contradictionPool();
    tables.get('cognitivePreference')!.findUnique = () => Promise.reject(new Error('库挂了'));

    await expect(sweep()).resolves.toMatchObject({ ran: false, failed: true });
    expect(writtenRecords()).toEqual([]);
  });
});

describe('逐情境闸门', () => {
  it('引用的记忆落在 emotionalSupport（默认不放行）⇒ 整条洞察不落地', async () => {
    contradictionPool();
    tables
      .get('memoryItem')!
      .rows.get('m2')!.context = 'EMOTIONAL_SUPPORT';
    switchOn();

    const outcome = await sweep();

    expect(outcome.gateBlocked).toBe(1);
    expect(writtenRecords()).toEqual([]);
  });

  it('用户显式把 emotionalSupport 的反思打开 ⇒ 同一条洞察可以落地', async () => {
    contradictionPool();
    tables.get('memoryItem')!.rows.get('m2')!.context = 'EMOTIONAL_SUPPORT';
    tables.get('memoryPolicy')!.seed({
      userId: USER,
      context: 'EMOTIONAL_SUPPORT',
      allowPersistence: true,
      allowedMemoryTypes: ['FACT'],
      requireConfirmation: false,
      retention: 'FOREVER',
      allowUserProfile: false,
      allowReflection: true,
      allowAssociation: false
    });
    switchOn();

    const outcome = await sweep();

    expect(outcome.gateBlocked).toBe(0);
    expect(writtenRecords()).toHaveLength(1);
  });

  it('私人反思情境默认也不放行：引用它的洞察同样落不了地', async () => {
    contradictionPool();
    tables.get('memoryItem')!.rows.get('m1')!.context = 'PERSONAL_REFLECTION';
    switchOn();

    const outcome = await sweep();

    expect(outcome.gateBlocked).toBe(1);
    expect(writtenRecords()).toEqual([]);
  });

  it('决策证据按 decisionMaking 档过闸（默认放开），而不是因为没有情境就放行', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', { confirmedAt: new Date('2026-10-20T00:00:00Z') });
    switchOn();

    const outcome = await sweep();

    expect(outcome.generated).toBe(1);
    expect(writtenRecords()[0]!.type).toBe('MILESTONE');
  });

  it('decisionMaking 档被用户关掉 ⇒ 决策洞察也不落地', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', { confirmedAt: new Date('2026-10-20T00:00:00Z') });
    tables.get('memoryPolicy')!.seed({
      userId: USER,
      context: 'DECISION_MAKING',
      allowPersistence: true,
      allowedMemoryTypes: ['DECISION'],
      requireConfirmation: true,
      retention: 'FOREVER',
      allowUserProfile: false,
      allowReflection: false,
      allowAssociation: true
    });
    switchOn();

    const outcome = await sweep();

    expect(outcome.gateBlocked).toBe(1);
    expect(writtenRecords()).toEqual([]);
  });
});

describe('隔离', () => {
  it('别的用户的记忆再成簇也不进这个用户的池子', async () => {
    contradictionPool(OTHER);
    switchOn();

    const outcome = await sweep();

    expect(outcome.ran).toBe(true);
    expect(outcome.generated).toBe(0);
    expect(writtenRecords()).toEqual([]);
  });

  it('写下去的洞察与引用行全部是同一个用户，引用只指自己读过的行', async () => {
    contradictionPool();
    memory('m9', '周末去爬山', { chatId: 'c9', userId: OTHER }, OTHER);
    switchOn();

    const outcome = await sweep();
    expect(outcome.generated).toBe(1);

    const record = writtenRecords()[0]!;
    expect(record.userId).toBe(USER);
    const citations = writtenCitations();
    expect(citations.length).toBeGreaterThan(0);
    for (const citation of citations) {
      expect(citation.userId).toBe(USER);
      expect(citation.reflectionId).toBe(record.id);
    }
    const mine = new Set([...tables.get('memoryItem')!.rows.values()].filter((row) => row.userId === USER).map((row) => row.id));
    for (const citation of citations) {
      const referenced = (citation.memoryId ?? citation.decisionId)!;
      expect(mine.has(String(referenced))).toBe(true);
    }
  });
});

describe('落库的形状', () => {
  it('一条互相打脸的洞察：标题、正文、时间、计数、置信度全部来自 finding 与 6-C 的算式', async () => {
    contradictionPool();
    switchOn();

    const outcome = await sweep();
    expect(outcome.generated).toBe(1);

    const record = writtenRecords()[0]!;
    expect(record.type).toBe('CONTRADICTION');
    expect(record.status).toBe('PENDING');
    expect(record.sampleCount).toBe(2);
    expect(record.observationSpanDays).toBe(19);
    expect(record.counterHitCount).toBe(0);
    expect(record.confidence).toBe(0.325);
    expect(record.timeFrom).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(record.timeTo).toEqual(new Date('2026-09-20T00:00:00Z'));
    expect(record.timePrecision).toBe('TIMESTAMP');
    expect(record.generatedAt).toEqual(NOW);

    const aad = (field: string) => `reflection:v1:${USER}:${record.id}:${field}`;
    expect(decryptString(String(record.titleCiphertext), aad('title'))).toBe('两句互相打脸');
    expect(bodyOf(record)).toBe(
      '这几句看着有关，但还说不定是不是一件事。前后说过 2 次，跨度 19 天。原话：「周末去爬山」、「周末不去爬山」。'
    );
    // 主题词集也是正文的派生物，按同一个口径加密。
    expect(tokenize(decryptString(String(record.counterTokensCiphertext), aad('counterTokens')))).toContain('爬山');
    expect(record.alternativesCiphertext).toBeNull();
  });

  it('洞察有失效期：读侧靠它把 PENDING 判成 EXPIRED（门槛 7 要求每个状态都有生产者）', async () => {
    contradictionPool();
    switchOn();

    await sweep();
    const { REFLECTION_TTL_DAYS } = await reflectionSweepConstants();

    const record = writtenRecords()[0]!;
    expect(REFLECTION_TTL_DAYS).toBe(30);
    expect(record.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it('洞察的支持引用写 SUPPORTS 行，记忆与决策两种来源都允许但必须恰好一列非空', async () => {
    contradictionPool();
    switchOn();

    await sweep();

    const citations = writtenCitations();
    expect(citations).toHaveLength(2);
    for (const citation of citations) {
      expect(citation.kind).toBe('SUPPORTS');
      expect(citation.memoryId === null).toBe(false);
      expect(citation.decisionId).toBeNull();
    }
    expect(citations.map((citation) => citation.memoryId).sort()).toEqual(['m1', 'm2']);
  });

  it('只有决策证据的洞察：引用行填 decisionId、memoryId 留 null，而且不会被 critic 误判成幽灵引用', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'));
    switchOn();

    const result = await sweep();

    expect(result.generated).toBe(1);
    expect(result.criticRejected).toBe(0);
    const record = writtenRecords()[0]!;
    expect(record.type).toBe('DECISION_LESSON');
    expect(record.sampleCount).toBe(1);
    expect(record.observationSpanDays).toBe(10);
    expect(record.confidence).toBe(0.167);

    const citations = writtenCitations();
    expect(citations).toHaveLength(1);
    expect(citations[0]!.decisionId).toBe('d1');
    expect(citations[0]!.memoryId).toBeNull();
    expect(citations[0]!.kind).toBe('SUPPORTS');
    expect(bodyOf(record)).toContain('原话：「把订单存储换成 PostgreSQL」。');
  });

  it('结果时间取该决策所有结果行里最早的那一条', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-09-05T00:00:00Z'));
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'));
    switchOn();

    await sweep();

    expect(writtenRecords()[0]!.observationSpanDays).toBe(10);
  });

  it('别人的结果行不算这个用户的证据', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'), OTHER);
    switchOn();

    const result = await sweep();

    // 结果行按 userId 过滤：拿不到自己的结果，OUTCOME_RECORDED 就出不了 DECISION_LESSON；
    // 而它状态不是 CONFIRMED，也出不了 MILESTONE（门槛 8）。这一轮什么都不写。
    expect(result.generated).toBe(0);
    expect(writtenRecords()).toEqual([]);
  });
});

describe('反证与置信度一起落库', () => {
  it('同主题里有一条被改过口的行 ⇒ counterHitCount 落库，正文带上余地那一句', async () => {
    contradictionPool();
    memory('m3', '周末在家休息', {
      chatId: 'c3',
      supersededAt: new Date('2026-10-01T00:00:00Z')
    });
    switchOn();

    const result = await sweep();

    const record = writtenRecords()[0]!;
    expect(result.generated).toBe(1);
    expect(record.counterHitCount).toBe(1);
    // 0.5*(2/6) + 0.5*(19/60) - 0.2*1
    expect(record.confidence).toBe(0.125);
    expect(bodyOf(record).endsWith(COUNTER_CLAUSE)).toBe(true);

    const contradicts = writtenCitations().filter((citation) => citation.kind === 'CONTRADICTS');
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0]!.memoryId).toBe('m3');
  });

  it('反证不改变它值不值得占那一屏的位置：importance 是不扣反证的那一份证据量', async () => {
    contradictionPool();
    memory('m3', '周末在家休息', { chatId: 'c3', supersededAt: new Date('2026-10-01T00:00:00Z') });
    switchOn();

    await sweep();

    expect(writtenRecords()[0]!.importance).toBe(0.325);
  });
});

describe('限量与不重复生成', () => {
  it('一轮最多落三条：四条同分洞察留下三条', async () => {
    for (const [id, topic] of [
      ['d1', '把订单存储换成 PostgreSQL'],
      ['d2', '把前端从 Vue 迁到 React'],
      ['d3', '周末报一个游泳班'],
      ['d4', '把家里换成扫地机器人']
    ]) {
      decision(id, topic, { confirmedAt: new Date('2026-10-20T00:00:00Z') });
    }
    switchOn();

    const result = await sweep();
    const { MAX_NEW_PER_SWEEP } = await reflectionSweepConstants();

    expect(MAX_NEW_PER_SWEEP).toBe(3);
    expect(result.generated).toBe(3);
    expect(result.dedupSkipped).toBe(0);
    expect(writtenRecords()).toHaveLength(3);
  });

  it('已经落过库的主题不再重复生成，落不了的那条在下一次扫描补上', async () => {
    for (const [id, topic] of [
      ['d1', '把订单存储换成 PostgreSQL'],
      ['d2', '把前端从 Vue 迁到 React'],
      ['d3', '周末报一个游泳班'],
      ['d4', '把家里换成扫地机器人']
    ]) {
      decision(id, topic, { confirmedAt: new Date('2026-10-20T00:00:00Z') });
    }
    switchOn();

    const first = await sweep();
    expect(first.generated).toBe(3);

    // 25 小时后再扫：已存在的三条不进候选，第四条才补得上。
    const second = await sweep(USER, new Date(NOW.getTime() + 25 * 3_600_000));

    expect(second.generated).toBe(1);
    expect(writtenRecords()).toHaveLength(4);
    expect(new Set(writtenRecords().map((record) => record.dedupKey)).size).toBe(4);
  });

  it('同一主题第二次写入被库层唯一约束挡下：只记一笔跳过，不抛错', async () => {
    contradictionPool();
    switchOn();

    const result = await sweep();
    expect(result.generated).toBe(1);
    const existing = writtenRecords()[0]!;

    // 绕过应用层的「已知主题」预筛：直接让库里那一行留在原地，模拟并发里抢先后到的一步。
    tables.get('reflectionRecord')!.findMany = () => Promise.resolve([]);
    const again = await sweep(USER, new Date(NOW.getTime() + 25 * 3_600_000));

    expect(again.dedupSkipped).toBe(1);
    expect(again.generated).toBe(0);
    expect(again.failed).toBe(false);
    expect(writtenRecords()).toHaveLength(1);
    expect(writtenRecords()[0]!.id).toBe(existing.id);
  });

  it('洞察写不进库 ⇒ 一条半截的引用都不留，并把这一轮标成失败', async () => {
    contradictionPool();
    switchOn();
    tables.get('reflectionRecord')!.create = () => Promise.reject(new Error('写库失败'));

    const result = await sweep();

    expect(result.failed).toBe(true);
    expect(result.generated).toBe(0);
    expect(writtenCitations()).toEqual([]);
  });
});

describe('证据不足只留计数', () => {
  it('每条 insufficient 都进日志，且日志里没有任何用户原话', async () => {
    contradictionPool();
    switchOn();

    const result = await sweep();

    // PATTERN 门槛 3 条样本，这里只有 2 ⇒ 一条证据不足。
    expect(result.insufficient).toBe(1);
    const insufficient = ctx.events.filter(([event]) => event === 'cognitive.reflection_insufficient');
    expect(insufficient).toHaveLength(1);
    expect(insufficient[0]![1]).toEqual({
      userId: USER,
      type: 'PATTERN',
      sampleCount: 2,
      observationSpanDays: 19,
      reason: 'BELOW_SAMPLE_MIN'
    });
    expect(ctx.events.every(([event, fields]) => !/[\u4e00-\u9fff]/.test(`${event}|${JSON.stringify(fields)}`))).toBe(
      true
    );
  });

  it('critic 的原因码进日志时也只有码', async () => {
    contradictionPool();
    switchOn();

    const result = await sweep();

    expect(result.criticRejected).toBe(0);
    const rejected = ctx.events.filter(([event]) => event === 'cognitive.reflection_critic_rejected');
    for (const [, fields] of rejected) {
      expect(typeof fields.reasons).toBe('object');
    }
    expect(
      ctx.events.every(([, fields]) => JSON.stringify(fields).includes('周末去爬山'))
    ).toBe(false);
  });
});

describe('扫描的硬截止', () => {
  it('池子读挂住 ⇒ 到截止就收，不把这个用户的下一轮任务拖住', async () => {
    contradictionPool();
    switchOn();
    tables.get('memoryItem')!.findMany = () => new Promise<Row[]>(() => undefined);

    const { REFLECTION_SWEEP_DEADLINE_MS } = await reflectionSweepConstants();
    vi.useFakeTimers();
    try {
      const running = sweep();
      await vi.advanceTimersByTimeAsync(REFLECTION_SWEEP_DEADLINE_MS);
      const result = await running;

      expect(result.ran).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(result.generated).toBe(0);
      expect(writtenRecords()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
