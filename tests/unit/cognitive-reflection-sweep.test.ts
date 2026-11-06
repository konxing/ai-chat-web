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

/**
 * 开关：只有 reflectionEnabled 和 memoryEnabled 两档和这一片有关，其余按库里的默认全关。
 * memoryEnabled 默认打开是正向对照——洞察的证据来自记忆行，关掉它就该什么都不读。
 */
function switchOn(userId = USER, sweptAt: Date | null = null, memoryEnabled = true) {
  tables.get('cognitivePreference')!.seed({
    userId,
    memoryEnabled,
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

function outcomeRow(
  decisionId: string,
  recordedAt: Date,
  userId = USER,
  overrides: Partial<Record<string, unknown>> = {}
) {
  tables.get('decisionOutcome')!.seed({
    id: `out-${decisionId}-${recordedAt.getTime()}`,
    userId,
    decisionId,
    linkStatus: 'LINKED',
    actualCiphertext: encryptString('成了', `decision-outcome:v1:${userId}:x:actual`),
    recordedAt,
    sourceMessageId: 'msg-out',
    ...overrides
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

/**
 * 按类型挑落库的洞察。一条 OUTCOME_RECORDED 的决策现在同时出 MILESTONE 和
 * DECISION_LESSON，`writtenRecords()[0]` 不再是「那条经验」，别再按位置取。
 */
function recordsOfType(type: string): Row[] {
  return writtenRecords().filter((row) => row.type === type);
}

function bodyOf(row: Row): string {
  return decryptString(String(row.bodyCiphertext), `reflection:v1:${row.userId}:${row.id}:body`);
}

/**
 * 落库的那一句解释。它对外的唯一去处是这个字段——正文里再抄一遍，读侧就分不清哪份为准。
 * 列名改了不认：`undefined` 会让 decryptString 抛，而不是静悄悄返回 null 让断言白过。
 */
function alternativesOf(row: Row): string | null {
  if (row.alternativesCiphertext === null) return null;
  return decryptString(
    String(row.alternativesCiphertext),
    `reflection:v1:${row.userId}:${row.id}:alternatives`
  );
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

/**
 * 后台扫描的证据就是记忆原文（pool 是 MemoryItem 行 + 逐行解密），所以
 * `memoryEnabled` 关着时这一片一行都不该读（任务书 1.1「关闭模块后不能继续执行对应的数据读取、
 * 生成和后台写入」）。但闸门落在**读池子之前、收割之后**：抢戳和收割只碰 ReflectionRecord
 * 自己的列，把 SNOOZED 一起冻住会让「稍后」变成只进不出的死状态。
 */
describe('memoryEnabled 关着时后台不读记忆', () => {
  it('reflectionEnabled 开着但 memoryEnabled 关着 ⇒ 不查记忆行、不写洞察', async () => {
    contradictionPool();
    switchOn(USER, null, false);
    const readMany = vi.spyOn(tables.get('memoryItem')!, 'findMany');

    const outcome = await sweep();

    expect(readMany).not.toHaveBeenCalled();
    expect(outcome.ran).toBe(true);
    expect(outcome.generated).toBe(0);
    expect(writtenRecords()).toEqual([]);
  });

  it('memoryEnabled 关着时戳照盖：抢冷却不该被记忆的闸门带走', async () => {
    contradictionPool();
    switchOn(USER, null, false);

    await sweep();

    expect(tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt).toBeInstanceOf(Date);
  });

  it('memoryEnabled 关着时收割照跑：到期和稍后到点都有人写', async () => {
    switchOn(USER, null, false);
    existingReflection('r-old', { expiresAt: new Date(NOW.getTime() - DAY) });
    existingReflection('r-snooze', {
      status: 'SNOOZED',
      snoozedUntil: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() + 30 * DAY)
    });

    const outcome = await sweep();

    expect(outcome.expired).toBe(1);
    expect(outcome.reactivated).toBe(1);
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

/**
 * 归档的记忆不再当反思的证据（任务书 7.2 的 ARCHIVE 撞上 Phase 6）。
 * 反思扫描不读 listMemories，它自己 findMany 捞 500 行的池子，所以「收起来」这件事
 * 必须在那一次查询里也成立——否则用户已经把这条藏好了，洞察还在正文里复述它。
 * 正向对照（同一份池子不归档时确实出一条）在上面的引用隔离那条里已经钉过。
 */
describe('归档的记忆不再当反思的证据', () => {
  it('打脸的两句里有一句已归档 ⇒ 这条冲突洞察不落地', async () => {
    contradictionPool();
    tables.get('memoryItem')!.rows.get('m2')!.archivedAt = new Date('2026-10-01T00:00:00Z');
    switchOn();

    const outcome = await sweep();

    expect(outcome.generated).toBe(0);
    expect(writtenRecords()).toEqual([]);
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
    // 标题是后说的那句原话：用户改过口，早先那句已经是他不要的说法（见 reflection-evidence.ts 红线一）。
    expect(decryptString(String(record.titleCiphertext), aad('title'))).toBe('「周末不去爬山」');
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

    // 这条决策同时是里程碑（用户确认过）和经验的依据（报过结果）：两条洞察，各带各的引用。
    expect(result.generated).toBe(2);
    expect(result.criticRejected).toBe(0);
    const lessons = recordsOfType('DECISION_LESSON');
    expect(lessons).toHaveLength(1);
    expect(recordsOfType('MILESTONE')).toHaveLength(1);
    const record = lessons[0]!;
    expect(record.sampleCount).toBe(1);
    expect(record.observationSpanDays).toBe(10);
    expect(record.confidence).toBe(0.167);

    const citations = writtenCitations().filter((row) => row.reflectionId === record.id);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.decisionId).toBe('d1');
    expect(citations[0]!.memoryId).toBeNull();
    expect(citations[0]!.kind).toBe('SUPPORTS');
    expect(bodyOf(record)).toContain('原话：「把订单存储换成 PostgreSQL」。');
    // 片Q-2：这一类的三种解释由措辞层产出、由这里原样落库，只在这个字段里出现一次。
    expect(alternativesOf(record)).toBe(
      '可能是这个决定带来的；可能是同期另一件事带来的；可能和这个决定没关系，环境本来就会这样'
    );
    expect(bodyOf(record)).not.toContain('可能是这个决定带来的');
    expect(bodyOf(record)).not.toContain('这几种解释');
  });

  it('结果时间取该决策所有已确认结果行里最早的那一条', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-09-05T00:00:00Z'));
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'));
    switchOn();

    await sweep();

    expect(recordsOfType('DECISION_LESSON')[0]!.observationSpanDays).toBe(10);
  });

  it('别人的结果行不算这个用户的证据', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'), OTHER);
    switchOn();

    await sweep();

    // 结果行按 userId 过滤：拿不到自己的结果，OUTCOME_RECORDED 也出不了 DECISION_LESSON。
    // 里程碑不受影响——它的依据是「确认过」这件事，本来就不需要结果行。
    expect(recordsOfType('DECISION_LESSON')).toEqual([]);
    expect(recordsOfType('MILESTONE')).toHaveLength(1);
  });

  it('用户否认过的归因不算报过结果：DETACHED 的结果行撑不起 DECISION_LESSON', async () => {
    // 状态是点头那一刻推上去的，之后用户可以再把这条归因摘掉。摘掉之后库里
    // 只剩一行 DETACHED——「结果」这件事已经被用户收回，洞察不能再拿它当经验证据。
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'), USER, { linkStatus: 'DETACHED' });
    switchOn();

    const result = await sweep();

    expect(recordsOfType('DECISION_LESSON')).toEqual([]);
    expect(result.generated).toBe(1);
  });

  it('还没点头的候选结果不算报过结果：CANDIDATE 撑不起 DECISION_LESSON', async () => {
    decision('d1', '把订单存储换成 PostgreSQL', {
      status: 'OUTCOME_RECORDED',
      confirmedAt: new Date('2026-08-01T00:00:00Z')
    });
    outcomeRow('d1', new Date('2026-08-11T00:00:00Z'), USER, { linkStatus: 'CANDIDATE' });
    switchOn();

    await sweep();

    expect(recordsOfType('DECISION_LESSON')).toEqual([]);
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

/**
 * 6-E 补的两件事：门槛 7 的两个缺口。
 *
 * 一、EXPIRED 和「稍后到期」这两个状态在此之前没有任何代码写过：洞察行带着 30 天的
 *    expiresAt 落库后一直停在 PENDING，SNOOZED 更是个只进不出的死状态。甲方案的判法是
 *    「抢到冷却后的第一件事」做一次条件 UPDATE——放在抢戳之后是因为开关关着的用户不该被后台改状态，
 *    放在读池子之前是因为收割和聚类没有依赖关系，而它得是每轮必到的。
 * 二、REJECTED 行的复活。去重键让一个被拒的主题永远进不来，于是「忽略」实际上变成了永久消音；
 *    甲方案的判法是只有**决定之后新记的同话题证据**才允许它再来一次，而且写回同一行——
 *    密文的 AAD 绑的就是那一行的 id，换新行等于换了加密口径。
 *    「同话题」实测后从「这条洞察的 supportMemoryIds 里有新行」改成了「池子里决定之后新记的行
 *    和这条洞察的主题词重合 ≥ 成簇阈值」：CONTRADICTION 的支持证据固定是相抵的那两句的代表，
 *    第三句同类的话根本不会进去，原判据在任何池子下都恒为 false（等于没有复活这条路）。
 *    改动带出的副作用也在这里钉住：第三句同话题的话本身会撑出一条新洞察（PATTERN），
 *    所以这几条测试全部按行 id 找目标，不再假设库里只有一行。
 */
function existingReflection(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  const aad = (field: string) => `reflection:v1:${USER}:${id}:${field}`;
  tables.get('reflectionRecord')!.seed({
    id,
    userId: USER,
    type: 'CONTRADICTION',
    status: 'PENDING',
    dedupKey: `key-${id}`,
    titleCiphertext: encryptString('旧标题', aad('title')),
    bodyCiphertext: encryptString('旧正文', aad('body')),
    alternativesCiphertext: null,
    counterTokensCiphertext: encryptString('爬山', aad('counterTokens')),
    counterHitCount: 1,
    timeFrom: new Date('2026-09-01T00:00:00Z'),
    timeTo: new Date('2026-09-20T00:00:00Z'),
    timePrecision: 'DAY',
    sampleCount: 2,
    observationSpanDays: 19,
    confidence: 0.5,
    importance: 0.5,
    generatedAt: new Date('2026-09-21T00:00:00Z'),
    snoozedUntil: null,
    expiresAt: null,
    decidedAt: null,
    ...overrides
  });
}

describe('收割：过期与稍后到期都要有人写', () => {
  it('PENDING 且 expiresAt 已过 ⇒ 置 EXPIRED 并计入 expired', async () => {
    existingReflection('r-old', { expiresAt: new Date(NOW.getTime() - 1000) });
    switchOn();

    const outcome = await sweep();

    expect(outcome.expired).toBe(1);
    expect(tables.get('reflectionRecord')!.rows.get('r-old')!.status).toBe('EXPIRED');
  });

  it('SNOOZED 到期 ⇒ 回到 PENDING 并清空 snoozedUntil，计入 reactivated', async () => {
    existingReflection('r-snooze', {
      status: 'SNOOZED',
      snoozedUntil: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() + 30 * DAY)
    });
    switchOn();

    const outcome = await sweep();

    expect(outcome.reactivated).toBe(1);
    const row = tables.get('reflectionRecord')!.rows.get('r-snooze')!;
    expect(row.status).toBe('PENDING');
    expect(row.snoozedUntil).toBeNull();
  });

  it('SNOOZED 还没到期 ⇒ 一个字都不动（否则稍后就等于没按）', async () => {
    existingReflection('r-snooze', {
      status: 'SNOOZED',
      snoozedUntil: new Date(NOW.getTime() + 3 * DAY)
    });
    switchOn();

    const outcome = await sweep();

    expect(outcome.reactivated).toBe(0);
    expect(tables.get('reflectionRecord')!.rows.get('r-snooze')!.status).toBe('SNOOZED');
  });

  it('已经有人处理过的行不被过期带走：ACCEPTED 即使带着过去的 expiresAt 也照原样留着', async () => {
    existingReflection('r-accepted', {
      status: 'ACCEPTED',
      expiresAt: new Date(NOW.getTime() - DAY)
    });
    switchOn();

    const outcome = await sweep();

    expect(outcome.expired).toBe(0);
    expect(tables.get('reflectionRecord')!.rows.get('r-accepted')!.status).toBe('ACCEPTED');
  });

  it('开关关着 ⇒ 一行都不收割：后台不许替关掉反思的用户改状态', async () => {
    existingReflection('r-old', { expiresAt: new Date(NOW.getTime() - DAY) });
    tables.get('cognitivePreference')!.seed({ userId: USER, reflectionEnabled: false });

    const outcome = await sweep();

    expect(outcome.ran).toBe(false);
    expect(tables.get('reflectionRecord')!.rows.get('r-old')!.status).toBe('PENDING');
  });

  it('收割数进摘要日志，但不带任何正文', async () => {
    existingReflection('r-old', { expiresAt: new Date(NOW.getTime() - DAY) });
    switchOn();

    await sweep();

    const summary = ctx.events.find(([event]) => event === 'cognitive.reflection_sweep');
    expect(summary![1]).toMatchObject({ userId: USER, expired: 1 });
    expect(JSON.stringify(summary![1])).not.toContain('旧正文');
  });
});

describe('复活：被忽略的主题只在新证据下再来一次', () => {
  /** 第一遍扫出那条洞察，然后按用户的动作把它改成 REJECTED。 */
  async function rejectedFromFirstSweep(decidedAt: Date) {
    contradictionPool();
    switchOn();
    const first = await sweep();
    expect(first.generated).toBe(1);
    const row = writtenRecords()[0]!;
    tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt = new Date(
      decidedAt.getTime() - 25 * 3_600_000
    );
    row.status = 'REJECTED';
    row.decidedAt = decidedAt;
    return row;
  }

  it('拒绝之后又记进同类的新一句 ⇒ 回到 PENDING，且写回的是同一行 id', async () => {
    const rejected = await rejectedFromFirstSweep(new Date('2026-10-01T00:00:00Z'));
    const rejectedId = String(rejected.id);
    const rejectedKey = String(rejected.dedupKey);
    const ciphertextBefore = String(rejected.bodyCiphertext);
    const expiresBefore = rejected.expiresAt as Date;
    const citationIdsBefore = writtenCitations()
      .filter((row) => row.reflectionId === rejectedId)
      .map((row) => row.id);
    memory('m3', '周末去爬山', {
      recordedAt: new Date('2026-10-20T00:00:00Z'),
      chatId: 'c3'
    });

    const outcome = await sweep(USER, new Date('2026-11-05T00:00:00Z'));

    expect(outcome.revived).toBe(1);
    // 第三句同话题的话自己撑出一条新洞察（PATTERN），那条算新生不算复活——两个计数各记各的。
    expect(outcome.generated).toBe(1);

    const row = tables.get('reflectionRecord')!.rows.get(rejectedId)!;
    // 同一行：AAD 绑的就是这个 id，换了 id 老密文就再也解不开。
    expect(row.dedupKey).toBe(rejectedKey);
    expect(row.status).toBe('PENDING');
    expect(row.decidedAt).toBeNull();
    // 钉的是「整行重写过」，不是「文字必须变」：实测下来 CONTRADICTION 的支持证据固定是那两句的代表，
    // 第三句同话题的话不会改进正文——复活改的是状态、时钟和证据，让同一句话重新排队一次。
    expect(String(row.bodyCiphertext)).not.toBe(ciphertextBefore);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(expiresBefore.getTime());
    // 老引用整批换掉：留着上一次的证据，等于让界面说出一个现在支撑不了的理由。
    const citationsNow = writtenCitations().filter((row2) => row2.reflectionId === rejectedId);
    expect(citationsNow.map((row2) => row2.id)).not.toEqual(citationIdsBefore);
    expect(citationsNow.length).toBeGreaterThan(0);
  });

  it('没有新证据 ⇒ 按去重跳过，那一行原样不动', async () => {
    const rejected = await rejectedFromFirstSweep(new Date('2026-10-01T00:00:00Z'));
    const rejectedId = String(rejected.id);
    const ciphertextBefore = String(rejected.bodyCiphertext);
    const generatedAtBefore = (rejected.generatedAt as Date).getTime();

    const outcome = await sweep(USER, new Date('2026-11-05T00:00:00Z'));

    expect(outcome.revived).toBe(0);
    expect(outcome.dedupSkipped).toBeGreaterThanOrEqual(1);
    const row = tables.get('reflectionRecord')!.rows.get(rejectedId)!;
    expect(row.status).toBe('REJECTED');
    expect(String(row.bodyCiphertext)).toBe(ciphertextBefore);
    expect((row.generatedAt as Date).getTime()).toBe(generatedAtBefore);
  });

  it('新记忆记在拒绝之前 ⇒ 不算新证据，不复活', async () => {
    const rejected = await rejectedFromFirstSweep(new Date('2026-10-01T00:00:00Z'));
    const rejectedId = String(rejected.id);
    memory('m3', '周末去爬山', {
      recordedAt: new Date('2026-09-25T00:00:00Z'),
      chatId: 'c3'
    });

    const outcome = await sweep(USER, new Date('2026-11-05T00:00:00Z'));

    expect(outcome.revived).toBe(0);
    expect(tables.get('reflectionRecord')!.rows.get(rejectedId)!.status).toBe('REJECTED');
  });

  it('采纳过的主题永不复活：去重键还在就还是不写，这是 6.6 而不是 6.4', async () => {
    contradictionPool();
    switchOn();
    await sweep();
    const accepted = writtenRecords()[0]!;
    const acceptedId = String(accepted.id);
    accepted.status = 'ACCEPTED';
    accepted.decidedAt = new Date('2026-10-01T00:00:00Z');
    const ciphertextBefore = String(accepted.bodyCiphertext);
    tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt = new Date('2026-10-10T00:00:00Z');
    memory('m3', '周末去爬山', { recordedAt: new Date('2026-10-20T00:00:00Z'), chatId: 'c3' });

    const outcome = await sweep(USER, new Date('2026-11-05T00:00:00Z'));

    expect(outcome.revived).toBe(0);
    expect(outcome.dedupSkipped).toBeGreaterThanOrEqual(1);
    const row = tables.get('reflectionRecord')!.rows.get(acceptedId)!;
    expect(row.status).toBe('ACCEPTED');
    expect(String(row.bodyCiphertext)).toBe(ciphertextBefore);
  });

  it('复活与新生共用同一份限量计数：一轮里落地的行不超过上限', async () => {
    const { MAX_NEW_PER_SWEEP } = await reflectionSweepConstants();
    expect(MAX_NEW_PER_SWEEP).toBe(3);
    await rejectedFromFirstSweep(new Date('2026-10-01T00:00:00Z'));
    memory('m3', '周末去爬山', {
      recordedAt: new Date('2026-10-20T00:00:00Z'),
      chatId: 'c3'
    });

    const outcome = await sweep(USER, new Date('2026-11-05T00:00:00Z'));

    expect(outcome.revived).toBe(1);
    // 复活和新生走的是同一个 prepared 数组、同一次 slice(0, MAX)，所以合计顶得上限。
    // 上限真正咬住的那一幕（4 条候选只落 3 条）由「限量」那组测试钉，这里钉的是「复活也占名额」这个口径。
    expect(outcome.generated + outcome.revived).toBeLessThanOrEqual(MAX_NEW_PER_SWEEP);
    // 复活写回原有那一行，不新增行：库里的行数 = 复活前那一条 + 这一轮新生。
    expect(writtenRecords()).toHaveLength(1 + outcome.generated);
  });
});

/**
 * 片Q-5：任务书 6.6 :722「设置可配置的冷却规则」在**消费者**这一侧的落点。
 *
 * 这一组只钉一件事：抢冷却戳那道条件 UPDATE（`reflection-sweep.ts:163`）用的尺子必须来自
 * 用户此刻这一档，而不是模块里那个写死的 24 小时。三档都是白名单，没有「0 小时」这种入口——
 * 聚类那一步是 O(n²)，任务书 6.6 给的节奏下限就是一天，把下限交给用户随便调低不是「可配置」。
 *
 * 最后两条是本片的重点：它们钉的是「按**此刻**读到的档位判」。改档位要立刻生效，
 * 而不是等下一轮——用户把节奏从每月调回每天，不该再为一轮没跑成的扫描等二十九天。
 */
describe('可配置冷却：抢戳按用户此刻那一档', () => {
  /**
   * 一条用例里跑两轮：文件顶层的 `beforeEach` 只在用例开始前清一次，
   * 所以第二轮要自己清——而且清完必须 `buildTables()`，那些表是 `named()` 缓存的，
   * 光清 Map 会让下一次 `tables.get(...)` 拿到 undefined。
   */
  function reset() {
    tables.clear();
    ctx.events.length = 0;
    buildTables();
  }

  /** 库里那一档写在 CognitivePreference 行上；替身不校验列，所以直接盖在种好的行上。 */
  function cooldown(tier: string, sweptAt: Date | null = null) {
    contradictionPool();
    switchOn(USER, sweptAt);
    tables.get('cognitivePreference')!.rows.get(USER)!.reflectionCooldown = tier;
  }

  it('WEEKLY + 3 天前扫过 ⇒ 冷却没到，不跑也不重盖戳', async () => {
    cooldown('WEEKLY', new Date(NOW.getTime() - 3 * DAY));

    const outcome = await sweep();

    expect(outcome.ran).toBe(false);
    expect(writtenRecords()).toEqual([]);
    expect(new Date(String(tables.get('cognitivePreference')!.rows.get(USER)!.reflectionSweptAt)).getTime()).toBe(
      NOW.getTime() - 3 * DAY
    );
  });

  it('WEEKLY + 6 天前扫过 ⇒ 已经比 24 小时久但仍没到一周，不跑', async () => {
    // 这一条是「档位真的被读了」的最小组合：同一个 6 天，daily 会跑、weekly 不跑。
    cooldown('WEEKLY', new Date(NOW.getTime() - 6 * DAY));

    expect((await sweep()).ran).toBe(false);
  });

  it('WEEKLY + 6 天前扫过、同一时刻按 daily 判 ⇒ 跑得起来（正向对照，证明上一条不是蒙对的）', async () => {
    contradictionPool();
    switchOn(USER, new Date(NOW.getTime() - 6 * DAY));

    const outcome = await sweep();

    expect(outcome.ran).toBe(true);
    expect(writtenRecords().length).toBeGreaterThan(0);
  });

  it('MONTHLY + 29 天前 ⇒ 不跑；+ 31 天前 ⇒ 跑', async () => {
    cooldown('MONTHLY', new Date(NOW.getTime() - 29 * DAY));
    expect((await sweep()).ran).toBe(false);

    reset();
    cooldown('MONTHLY', new Date(NOW.getTime() - 31 * DAY));
    expect((await sweep()).ran).toBe(true);
  });

  it('DAILY 就是今天那一档：23 小时前不跑、25 小时前跑，写死的常量搬进偏好后行为不变', async () => {
    cooldown('DAILY', new Date(NOW.getTime() - 25 * 3_600_000));
    expect((await sweep()).ran).toBe(true);

    reset();
    cooldown('DAILY', new Date(NOW.getTime() - 23 * 3_600_000));
    expect((await sweep()).ran).toBe(false);
  });

  it('正好满 24 小时 ⇒ 跑：判的是「满」，不是还要多等一毫秒', async () => {
    // 界面那句「距上次生成满 24 小时」是设置页给用户的口径，抢戳那句比较必须和它一个字不差。
    cooldown('DAILY', new Date(NOW.getTime() - 24 * 3_600_000));

    expect((await sweep()).ran).toBe(true);
  });

  it('从没扫过 ⇒ 三档都抢得到，冷却不该把第一次扫描挡在门外', async () => {
    for (const tier of ['DAILY', 'WEEKLY', 'MONTHLY']) {
      reset();
      cooldown(tier, null);
      expect(await sweep().then((got) => got.ran)).toBe(true);
    }
  });

  it('从每月调回每天 ⇒ 当场生效：6 天前那一轮在新档位下已经算到期', async () => {
    cooldown('MONTHLY', new Date(NOW.getTime() - 6 * DAY));
    expect((await sweep()).ran).toBe(false);

    // 只改偏好那一列，别的什么都不动——这一条守的是「尺子每次抢戳现读，不是盖戳时那次读的」。
    tables.get('cognitivePreference')!.rows.get(USER)!.reflectionCooldown = 'DAILY';

    expect((await sweep()).ran).toBe(true);
  });

  it('从每天调到每月 ⇒ 也当场生效：昨天那一轮在新档位下还没到期', async () => {
    cooldown('DAILY', new Date(NOW.getTime() - 25 * 3_600_000));
    expect((await sweep()).ran).toBe(true);

    reset();
    cooldown('DAILY', new Date(NOW.getTime() - 25 * 3_600_000));
    tables.get('cognitivePreference')!.rows.get(USER)!.reflectionCooldown = 'MONTHLY';

    expect((await sweep()).ran).toBe(false);
  });
});
