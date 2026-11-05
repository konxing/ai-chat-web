import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '@/lib/crypto';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 待确认候选（任务书 1.2 的 ASK_CONFIRM 那一格）。
 *
 * 落这一片之前，「先问再记」是假的：`memory-module.ts:266` 那句
 * `if (plan.decision !== 'WRITE' && plan.decision !== 'UPDATE') continue;`
 * 把 ASK_CONFIRM 和 IGNORE 一起丢掉，用户把某个情境设成「先问再记」之后，
 * 结果既不是记住也不是问他，是这条信息凭空消失。任务书 1.2 要求七种动作都落地，
 * 这里补的就是那一种。
 *
 * 为什么另开一张表而不是在 MemoryItem 上加一列 status：
 * 未确认的话**在任何一条现有读路径上都不得出现**。MemoryItem 已经有对话注入、
 * 时间线、变化、网络、洞察、画像六条读路，加一列就得每条都记得过滤，漏一处就是
 * 「系统把自己的猜测当成用户说过的话带进提示词」——那正是任务书最后那句禁止的事。
 * 表分开，这类错误按结构就不可能发生。
 *
 * 状态只有三个：PENDING / CONFIRMED / REJECTED。确认走 origin=USER_CONFIRMED
 * （不是 EXPLICIT：用户没有亲口说过这句话，是他看过之后点头说「这个可以记」），
 * 且 confirmedAt 落在**点确认的那一刻**，不是那句话被说出的时刻。
 *
 * 候选键复用排除规则的 `exclusionHash`（HMAC(APP_SECRET, userId:归一化正文)）：
 * 「这句是不是已经问过了」和「这句是不是被删过」必须是同一个「这句」的定义，
 * 两处各算一份就会漂，漂的结果是同一句话既能被排除又还在反复问。
 *
 * 边界（和 docs/cognitive-acceptance.md 里那条老边界同一条）：这里的 prisma 替身是
 * **谓词求值器不是 SQL**，「确认」那两步（抢占候选行 + 写记忆行）的原子性靠真库事务，
 * 在替身上换不来。本文件测的是协议形状：谁能被确认、确认后落了什么、拒绝留下什么。
 */

const USER = 'user-a';
const OTHER = 'user-b';

const tables = new Map<string, MockTable>();

function table(name: string, options = {}): MockTable {
  let current = tables.get(name);
  if (!current) {
    current = createTable(options);
    tables.set(name, current);
  }
  return current;
}

/**
 * `status` 由夹具补：schema 上是 `@default(PENDING)`，真库在建行时填这一列，
 * 服务层的 create 因此不传它。替身不补的话，「新行是待确认」测到的是夹具漏掉的列。
 */
const candidates = () =>
  table('memoryCandidate', { unique: [['userId', 'contentHash']], defaults: () => ({ status: 'PENDING' }) });
/** 记忆表同理：`recordedAt`/`version` 由库填，服务层的 create 不传，所以夹具得补上。 */
const memoryItems = () =>
  table('memoryItem', { defaults: () => ({ recordedAt: new Date(), version: 1, supersededAt: null, archivedAt: null }) });
const evidence = () => table('memoryEvidence');
const signals = () => table('memoryPolicySignal');
/**
 * 偏好表：拒绝要顺手记一条学习证据，而记不记由第八个开关（`adaptiveMemoryEnabled`）说了算。
 * 这张表在这里只装那一列——闸门读不出来时按「没配过行＝全关」走，和 `{...OFF}` 同一支。
 */
const preferences = () => table('cognitivePreference', { idField: 'userId' });

/** 打开/关掉自适应学习。默认关：没配过偏好的用户不该被系统偷偷学着点什么。 */
function setLearning(userId: string = USER, adaptiveMemoryEnabled: boolean = true): void {
  preferences().seed({ userId, adaptiveMemoryEnabled });
}

/**
 * 替身在第一次被 import 时才求值（本文件顶层不 import `@/lib/prisma`，服务模块都走 `await import`），
 * 所以 `tables` 已经建好。`$transaction` 展开成同一批表对象，这样「事务里的写」和
 * 「用例里的读」看到的是同一份行——但**展开不是回滚**，原子性测不到，边界见文件头。
 */
vi.mock('@/lib/prisma', () => {
  const tx = {
    memoryCandidate: candidates(),
    memoryItem: memoryItems(),
    memoryEvidence: evidence(),
    memoryPolicySignal: signals(),
    cognitivePreference: preferences()
  };
  return { prisma: { ...tx, $transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } };
});

async function service() {
  return await import('@/lib/cognitive/memory-candidates');
}

function propose(overrides: Record<string, unknown> = {}) {
  return service().then(({ proposeCandidate }) =>
    proposeCandidate({
      userId: USER,
      type: 'preference',
      context: 'personalGoal',
      content: '我最近在想要不要换个工作方向',
      precision: 'unknown',
      validFrom: null,
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      ...overrides
    })
  );
}

const candidateAad = (userId: string, id: string) => `memory-candidate:v1:${userId}:${id}`;

function seedCandidate(overrides: Row): Row {
  const id = String(overrides.id);
  const row: Row = {
    id,
    userId: USER,
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'PREFERENCE',
    context: 'PERSONAL_GOAL',
    contentCiphertext: encryptString(String(overrides.content ?? '测试正文'), candidateAad(USER, id)),
    contentHash: `hash-${id}`,
    status: 'PENDING',
    validPrecision: 'UNKNOWN',
    validFrom: null,
    decidedAt: null,
    createdAt: new Date(Date.parse('2026-11-01T00:00:00Z') + Number(overrides.seq ?? 0) * 60_000),
    ...overrides
  };
  candidates().seed(row);
  return row;
}

beforeEach(async () => {
  await service();
  for (const current of tables.values()) current.rows.clear();
});

describe('待确认候选（任务书 1.2 的 ASK_CONFIRM）', () => {
  it('提出：入库一行 PENDING，正文按候选自己的 AAD 加密存', async () => {
    const { proposeCandidate } = await service();
    const result = await proposeCandidate({
      userId: USER,
      type: 'preference',
      context: 'personalGoal',
      content: '我最近在想要不要换个工作方向',
      precision: 'unknown',
      validFrom: null,
      chatId: 'chat-1',
      sourceMessageId: 'msg-1'
    });

    expect(result.created).toBe(true);
    const row = candidates().rows.get(result.id) as Row;
    expect(row.status).toBe('PENDING');
    expect(String(row.contentCiphertext)).not.toContain('换个工作方向');
    expect(decryptString(String(row.contentCiphertext), candidateAad(USER, result.id))).toBe(
      '我最近在想要不要换个工作方向'
    );
    // 确认之前，这条话一条都不许出现在记忆表里。
    expect(memoryItems().rows.size).toBe(0);
  });

  it('同一句话不重复问：第二次提出复用既有行，不新增', async () => {
    const first = await propose();
    const second = await propose();

    expect(candidates().rows.size).toBe(1);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it('换标点空格算同一句：候选键和排除规则共用同一个归一化哈希', async () => {
    const { exclusionHash } = await import('@/lib/cognitive/exclusions');
    const first = await propose({ content: '我最近在想要不要换个工作方向。' });
    const row = candidates().rows.get(first.id) as Row;
    expect(row.contentHash).toBe(exclusionHash(USER, '我最近在想要不要换个工作方向。'));

    const second = await propose({ content: '  我最近在想要不要换个工作方向  ' });
    expect(second.id).toBe(first.id);
    expect(candidates().rows.size).toBe(1);
  });

  it('列表只回待确认，按提出时间倒序，并解密正文', async () => {
    seedCandidate({ id: 'old', content: '旧的那句', seq: 1 });
    seedCandidate({ id: 'new', content: '新的那句', seq: 9 });
    seedCandidate({ id: 'done', content: '已经处理过的', seq: 5, status: 'CONFIRMED', decidedAt: new Date() });

    const { listCandidates } = await service();
    const list = await listCandidates(USER);

    expect(list.map((item) => item.id)).toEqual(['new', 'old']);
    expect(list.map((item) => item.content)).toEqual(['新的那句', '旧的那句']);
    expect(list[0].status).toBe('pending');
  });

  it('确认：候选变 CONFIRMED，同时落一条 origin=USER_CONFIRMED 的记忆', async () => {
    const { id } = await propose();
    const { confirmCandidate } = await service();
    const memory = await confirmCandidate(id, USER);

    const row = candidates().rows.get(id) as Row;
    expect(row.status).toBe('CONFIRMED');
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(memory.origin).toBe('userConfirmed');
    expect(memory.content).toBe('我最近在想要不要换个工作方向');
    expect(memory.confirmedAt).not.toBeNull();

    const memoryRow = memoryItems().rows.get(memory.id) as Row;
    expect(memoryRow.origin).toBe('USER_CONFIRMED');
    expect(memoryRow.userId).toBe(USER);
  });

  it('确认：来源对话、消息 id、时间和精度都从候选带到记忆行', async () => {
    const validFrom = new Date(Date.UTC(2026, 10, 1));
    const { id } = await propose({ precision: 'month', validFrom, chatId: 'chat-9', sourceMessageId: 'msg-9' });
    const { confirmCandidate } = await service();
    const memory = await confirmCandidate(id, USER);

    expect(memory.chatId).toBe('chat-9');
    expect(memory.sourceMessageId).toBe('msg-9');
    expect(memory.precision).toBe('month');
    expect(memory.validFrom).toBe(validFrom.toISOString());
    // 记忆行自带一条支持证据：用户确认过这件事，就是这条记忆目前唯一的凭据。
    const rows = await evidence().findMany({ where: { memoryId: memory.id } });
    expect(rows.map((r) => r.kind)).toEqual(['SUPPORTS']);
  });

  it('拒绝：候选变 REJECTED、不产生记忆，并给这个情境记一条学习信号', async () => {
    setLearning();
    const { id } = await propose();
    const { rejectCandidate } = await service();
    const context = await rejectCandidate(id, USER);

    const row = candidates().rows.get(id) as Row;
    expect(context).toBe('personalGoal');
    expect(row.status).toBe('REJECTED');
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(memoryItems().rows.size).toBe(0);

    const signalRows = await signals().findMany({ where: { userId: USER } });
    expect(signalRows.map((r) => r.context)).toEqual(['PERSONAL_GOAL']);
  });

  /**
   * 拒绝和永久删除说的是同一件事（「这句我不要你记住」），所以它共用同一个闸门：
   * 第八个开关关着时一条证据都不攒。少这一道，用户关掉「自动收紧」之后，
   * 点几次「不要记」照样会把某个情境悄悄学成「先问再记」——那正是开关反对的事。
   */
  it('策略学习没打开：拒绝照样生效，但一条证据都不攒', async () => {
    const { id } = await propose();
    const { rejectCandidate } = await service();

    await expect(rejectCandidate(id, USER)).resolves.toBe('personalGoal');

    expect(candidates().rows.get(id)).toMatchObject({ status: 'REJECTED' });
    expect(signals().rows.size).toBe(0);
  });

  it('学习开着、拒绝别人的一句：404，候选行和证据都不动', async () => {
    setLearning();
    const { id } = await propose({ userId: OTHER });
    const { rejectCandidate } = await service();

    await expect(rejectCandidate(id, USER)).rejects.toMatchObject({ status: 404 });

    expect(candidates().rows.get(id)).toMatchObject({ status: 'PENDING', userId: OTHER });
    expect(signals().rows.size).toBe(0);
  });

  it('别人的候选：确认和拒绝都是 404，别人的行一个字节都不动', async () => {
    const { id } = await propose({ userId: OTHER });
    const { confirmCandidate, rejectCandidate } = await service();

    await expect(confirmCandidate(id, USER)).rejects.toMatchObject({ status: 404 });
    await expect(rejectCandidate(id, USER)).rejects.toMatchObject({ status: 404 });
    expect(candidates().rows.get(id)).toMatchObject({ status: 'PENDING', userId: OTHER });
    expect(memoryItems().rows.size).toBe(0);
  });

  it('已经决断过的候选再点：409，且不再产生第二条记忆', async () => {
    const { id } = await propose();
    const { confirmCandidate, rejectCandidate } = await service();
    await confirmCandidate(id, USER);
    const afterFirst = memoryItems().rows.size;

    await expect(confirmCandidate(id, USER)).rejects.toMatchObject({ status: 409 });
    await expect(rejectCandidate(id, USER)).rejects.toMatchObject({ status: 409 });
    expect(memoryItems().rows.size).toBe(afterFirst);
  });

  it('空正文和超长正文按记忆正文同一套校验拦下', async () => {
    await expect(propose({ content: '   ' })).rejects.toThrow(/正文/);
    await expect(propose({ content: '长'.repeat(1001) })).rejects.toThrow(/正文/);
    expect(candidates().rows.size).toBe(0);
  });

  it('待确认攒过上限只淘汰 PENDING：已决断的行留着', async () => {
    const { MAX_PENDING_CANDIDATES } = await service();
    for (let index = 0; index < MAX_PENDING_CANDIDATES; index += 1) {
      seedCandidate({ id: `p${index}`, content: `第 ${index} 句`, seq: index });
    }
    seedCandidate({ id: 'kept', content: '早就处理过的', seq: 9999, status: 'REJECTED', decidedAt: new Date() });

    const { proposeCandidate } = await service();
    const latest = await proposeCandidate({
      userId: USER,
      type: 'preference',
      context: 'personalGoal',
      content: '最新的一句',
      precision: 'unknown',
      validFrom: null
    });

    const pending = await candidates().findMany({ where: { userId: USER, status: 'PENDING' } });
    expect(pending.length).toBe(MAX_PENDING_CANDIDATES);
    expect(pending.map((r) => r.id)).toContain(latest.id);
    expect(pending.map((r) => r.id)).not.toContain('p0');
    expect(candidates().rows.get('kept')).toMatchObject({ status: 'REJECTED' });
  });

  it('这一屏之外的读路径看不见候选：记忆表一条新行都没写过', async () => {
    const { listMemories } = await import('@/lib/cognitive/memories');
    await propose();
    await propose({ content: '另一句还没确认的话', sourceMessageId: 'msg-2' });

    expect(await listMemories(USER)).toEqual([]);
    expect(memoryItems().rows.size).toBe(0);
  });
});
