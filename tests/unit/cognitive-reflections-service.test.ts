import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '@/lib/crypto';
import { createTable, type MockTable } from './prisma-mock';

/**
 * 6-E：反思的读侧与状态机（任务书 6.4 的六个状态、6.6 的限量、7.4 的门槛 7）。
 *
 * 这一片第一次让洞察**被人看见并被人处置**，所以钉的是四条边界：
 * 一、闸门在最前面，而且偏好读不出来按关闭处理——和 timeline / decisions 同一个口径。
 *    关着的用户不该为一次读请求把密文全解一遍。
 * 二、「过期」是读出来的，不是只有写出来的：sweep 的收割一天最多一次，中间那段时间里
 *    `status` 还是 PENDING 而 `expiresAt` 已经过了。读侧必须自己判，否则 30 天的 TTL
 *    在界面上要拖到下一次扫描才生效。
 * 三、状态机的入口只有 PENDING 这一个状态（`where` 里带着它），并且**采纳一个字都不多写**：
 *    不建记忆行、不写用户画像——那是 6-B 立项时定下的甲方案，界面不能替用户「记住」。
 * 四、引用行解不出源行时如实说 `text: null`。用户删了那条记忆，这条洞察的证据就少了一条，
 *    编一句出来就是把门槛 4 换成门槛 5 想拦住的那种东西。
 *
 * 边界同 6-D：跑的是内存求值器不是 SQL，行锁和真库级联不在本文件的证明范围。
 */

const tables = new Map<string, MockTable>();

function named(name: string, build: () => MockTable): MockTable {
  let table = tables.get(name);
  if (!table) {
    table = build();
    tables.set(name, table);
  }
  return table;
}

function buildTables() {
  return {
    cognitivePreference: named('cognitivePreference', () => createTable({ idField: 'userId' })),
    memoryItem: named('memoryItem', () => createTable()),
    decisionRecord: named('decisionRecord', () => createTable()),
    reflectionRecord: named('reflectionRecord', () => createTable()),
    reflectionCitation: named('reflectionCitation', () => createTable())
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    get cognitivePreference() {
      return buildTables().cognitivePreference;
    },
    get memoryItem() {
      return buildTables().memoryItem;
    },
    get decisionRecord() {
      return buildTables().decisionRecord;
    },
    get reflectionRecord() {
      return buildTables().reflectionRecord;
    },
    get reflectionCitation() {
      return buildTables().reflectionCitation;
    }
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY = 86_400_000;

const aad = (id: string, field: string) => `reflection:v1:${USER}:${id}:${field}`;

/** 偏好行按库里的形状整行塞：读侧要的是那一列，缺列会让 toPreferences 先炸掉。 */
function switchOn(userId = USER, reflectionEnabled = true, memoryEnabled = true) {
  preferenceTable().seed({
    userId,
    memoryEnabled,
    userModelEnabled: false,
    emotionEnabled: false,
    associationEnabled: false,
    timelineEnabled: false,
    reflectionEnabled,
    decisionMemoryEnabled: false,
    adaptiveMemoryEnabled: false,
    emotionTransparency: 'IMPLICIT',
    reflectionSweptAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW)
  });
}

function reflection(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    userId: USER,
    type: 'PATTERN',
    status: 'PENDING',
    dedupKey: `key-${id}`,
    titleCiphertext: encryptString('你最近三个月反复回到同一件事', aad(id, 'title')),
    bodyCiphertext: encryptString('你说「先把手头的做完」三次，每次都换了一个项目。', aad(id, 'body')),
    alternativesCiphertext: encryptString('也可能是排期本身不稳。', aad(id, 'alternatives')),
    counterTokensCiphertext: encryptString('排期 项目', aad(id, 'counterTokens')),
    counterHitCount: 1,
    timeFrom: new Date('2026-08-01T00:00:00Z'),
    timeTo: new Date('2026-11-01T00:00:00Z'),
    timePrecision: 'MONTH',
    sampleCount: 3,
    observationSpanDays: 92,
    confidence: 0.62,
    importance: 0.7,
    generatedAt: new Date('2026-11-01T00:00:00Z'),
    snoozedUntil: null,
    expiresAt: new Date(NOW.getTime() + 30 * DAY),
    decidedAt: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides
  };
}

async function service() {
  return import('@/lib/cognitive/reflections');
}

describe('闸门：读侧只在开关打开时读库', () => {
  beforeEach(() => {
    tables.clear();
  });

  it('开关开着 ⇒ 认得出它是开着（关着的用例不许靠「反正读不出」蒙过这一条）', async () => {
    switchOn();
    const module = await service();
    expect(await module.reflectionModuleEnabled(USER)).toBe(true);
  });

  it('开关关着 ⇒ reflectionModuleEnabled 为 false', async () => {
    switchOn(USER, false);
    const module = await service();
    expect(await module.reflectionModuleEnabled(USER)).toBe(false);
  });

  it('偏好读不出来 ⇒ 按关闭处理，不按「大概是开着」放行', async () => {
    switchOn();
    // 真库这一读是 findUnique；让它炸，才试得出服务层收没收得住。
    preferenceTable().findUnique = () => {
      throw new Error('数据库连接中断');
    };
    const module = await service();
    expect(await module.reflectionModuleEnabled(USER)).toBe(false);
  });

  /**
   * 单条详情的证据是记忆原文，所以那道闸门要两道都读：`reflectionEnabled` 管「能不能看洞察」，
   * `memoryEnabled` 管「能不能解密这一行 MemoryItem」。一次调用读一遍偏好。
   */
  it('证据闸门：两个开关都开着才都放行', async () => {
    switchOn();
    const module = await service();
    expect(await module.reflectionGates(USER)).toEqual({ reflectionEnabled: true, memoryEnabled: true });
  });

  it('证据闸门：memoryEnabled 关着 ⇒ 偏好里是 false，洞察开关不受牵连', async () => {
    switchOn(USER, true, false);
    const module = await service();
    expect(await module.reflectionGates(USER)).toEqual({ reflectionEnabled: true, memoryEnabled: false });
  });

  it('证据闸门：偏好读不出来 ⇒ 两道都按关闭处理', async () => {
    switchOn();
    preferenceTable().findUnique = () => {
      throw new Error('数据库连接中断');
    };
    const module = await service();
    expect(await module.reflectionGates(USER)).toEqual({ reflectionEnabled: false, memoryEnabled: false });
  });
});

describe('列表：密文变回明文，过期在读取时判出来', () => {
  beforeEach(() => {
    tables.clear();
    switchOn();
  });

  it('回到调用方的是解开的标题和正文，密文列一个都不带', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    const got = await module.listReflections(USER, { now: NOW });
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toBe('你最近三个月反复回到同一件事');
    expect(got[0]!.body).toContain('你说「先把手头的做完」三次');
    expect(JSON.stringify(got[0])).not.toContain('Ciphertext');
  });

  it('没有竞争解释的行 ⇒ alternatives 是 null，不是空串', async () => {
    reflectionTable().seed(reflection('r1', { alternativesCiphertext: null }));
    const module = await service();
    const got = await module.listReflections(USER, { now: NOW });
    expect(got[0]!.alternatives).toBeNull();
  });

  // 片Q-3：库里存的是 0.62 这种三位小数，屏幕上摆的是「把握中」。
  // 分数一旦出服务端就会长出 `.toFixed(2)`，一个规则算出来的定性数会被读成精确真理——
  // 记忆屏（1b）早就定了同一个口径，这屏不许反着来。
  it('服务端只给档位，一个分数都不给：两条下界走的是写侧那一条规则，confidence / importance 都不出服务端', async () => {
    reflectionTable().seed(
      // 0.7 / 0.699 / 0.4 / 0.399 是**下界本身**，不是随手取的数：只有它们能测出读侧是不是
      // 自己另算了一遍档。按记忆屏那组 0.75/0.45 算，0.7 会掉成 medium、0.4 会掉成 low。
      reflection('r1', { confidence: 0.7 }),
      reflection('r2', { confidence: 0.699 }),
      reflection('r3', { confidence: 0.4 }),
      reflection('r4', { confidence: 0.399 })
    );
    const module = await service();
    const got = await module.listReflections(USER, { now: NOW });
    expect(new Map(got.map((row) => [row.id, row.confidenceBand]))).toEqual(
      new Map([
        ['r1', 'high'],
        ['r2', 'medium'],
        ['r3', 'medium'],
        ['r4', 'low']
      ])
    );
    for (const row of got) {
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('importance');
    }
    expect(JSON.stringify(got)).not.toContain('"confidence":');
  });

  it('PENDING 但 expiresAt 已过 ⇒ 派生成 EXPIRED，且按 state=PENDING 过滤时它不在列表里', async () => {
    reflectionTable().seed(
      reflection('r1'),
      reflection('r2', { expiresAt: new Date(NOW.getTime() - DAY) })
    );
    const module = await service();
    const all = await module.listReflections(USER, { now: NOW });
    expect(new Map(all.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        ['r1', 'PENDING'],
        ['r2', 'EXPIRED']
      ])
    );
    const pending = await module.listReflections(USER, { now: NOW, state: 'PENDING' });
    expect(pending.map((row) => row.id)).toEqual(['r1']);
  });

  it('SNOOZED 没到期 ⇒ 状态照原样回，也不混进待处理那一屏', async () => {
    reflectionTable().seed(
      reflection('r1', { status: 'SNOOZED', snoozedUntil: new Date(NOW.getTime() + 3 * DAY) })
    );
    const module = await service();
    const got = await module.listReflections(USER, { now: NOW });
    expect(got[0]!.status).toBe('SNOOZED');
    expect(await module.listReflections(USER, { now: NOW, state: 'PENDING' })).toEqual([]);
  });

  it('别人的洞察一行都不回（连 id 都不给）', async () => {
    reflectionTable().seed(reflection('r1', { userId: OTHER }));
    const module = await service();
    expect(await module.listReflections(USER, { now: NOW })).toEqual([]);
  });
});

describe('证据：引用行指到谁，就读出谁', () => {
  beforeEach(() => {
    tables.clear();
    switchOn();
  });

  it('支持证据解出记忆正文，反对证据标成 CONTRADICTS', async () => {
    reflectionTable().seed(reflection('r1'));
    memoryTable().seed({
      id: 'm1',
      userId: USER,
      contentCiphertext: encryptString('我住在杭州', `memory:v1:${USER}:m1`),
      recordedAt: new Date('2026-10-01T00:00:00Z')
    });
    citationTable().seed(
      { id: 'c1', userId: USER, reflectionId: 'r1', memoryId: 'm1', decisionId: null, kind: 'SUPPORTS' },
      { id: 'c2', userId: USER, reflectionId: 'r1', memoryId: 'm1', decisionId: null, kind: 'CONTRADICTS' }
    );
    const module = await service();
    const found = await module.getReflectionWithCitations(USER, 'r1', { now: NOW });
    expect(found!.citations).toHaveLength(2);
    expect(found!.citations[0]!.text).toBe('我住在杭州');
    expect(new Set(found!.citations.map((row) => row.kind))).toEqual(new Set(['SUPPORTS', 'CONTRADICTS']));
  });

  it('源记忆已被用户删掉 ⇒ text 是 null，不编一句话顶上', async () => {
    reflectionTable().seed(reflection('r1'));
    citationTable().seed({
      id: 'c1',
      userId: USER,
      reflectionId: 'r1',
      memoryId: 'm-gone',
      decisionId: null,
      kind: 'SUPPORTS'
    });
    const module = await service();
    const found = await module.getReflectionWithCitations(USER, 'r1', { now: NOW });
    expect(found!.citations).toEqual([
      expect.objectContaining({ memoryId: 'm-gone', kind: 'SUPPORTS', text: null })
    ]);
  });

  it('决策证据解出的是主题，不是整条决策', async () => {
    reflectionTable().seed(reflection('r1', { type: 'DECISION_LESSON' }));
    decisionTable().seed({
      id: 'd1',
      userId: USER,
      topicCiphertext: encryptString('把订单存储换成 PostgreSQL', `decision:v1:${USER}:d1:topic`)
    });
    citationTable().seed({
      id: 'c1',
      userId: USER,
      reflectionId: 'r1',
      memoryId: null,
      decisionId: 'd1',
      kind: 'SUPPORTS'
    });
    const module = await service();
    const found = await module.getReflectionWithCitations(USER, 'r1', { now: NOW });
    expect(found!.citations[0]!.text).toBe('把订单存储换成 PostgreSQL');
  });

  it('越权读取别人的洞察 ⇒ null，和「不存在」同一个答案', async () => {
    reflectionTable().seed(reflection('r1', { userId: OTHER }));
    const module = await service();
    expect(await module.getReflectionWithCitations(USER, 'r1', { now: NOW })).toBeNull();
  });
});

describe('状态机：入口只有 PENDING，采纳不多写一个字', () => {
  beforeEach(() => {
    tables.clear();
    switchOn();
  });

  it('accept ⇒ 只改状态和 decidedAt，一条记忆都不新增', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    const got = await module.setReflectionStatus(USER, 'r1', { action: 'accept', now: NOW });
    expect(got.status).toBe('ACCEPTED');
    expect(got.decidedAt).toBe(NOW.toISOString());
    expect(memoryTable().rows.size).toBe(0);
  });

  it('reject ⇒ 置 REJECTED、盖 decidedAt，行留在库里等复活', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    await module.setReflectionStatus(USER, 'r1', { action: 'reject', now: NOW });
    const row = reflectionTable().rows.get('r1')!;
    expect(row.status).toBe('REJECTED');
    expect(row.decidedAt).toEqual(NOW);
  });

  it('edit ⇒ 正文换成用户改的那份，系统原话一个字都不留在库里', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    const got = await module.setReflectionStatus(USER, 'r1', {
      action: 'edit',
      now: NOW,
      title: '我确实总在换项目',
      body: '原因是我一开始就没想清楚要什么。'
    });
    expect(got.status).toBe('EDITED');
    const row = reflectionTable().rows.get('r1')!;
    // AAD 绑的还是那一行的 id：换了口径这一句就解不开，所以这里同时钉住了加密口径。
    expect(decryptString(String(row.titleCiphertext), aad('r1', 'title'))).toBe('我确实总在换项目');
    expect(decryptString(String(row.bodyCiphertext), aad('r1', 'body'))).toBe(
      '原因是我一开始就没想清楚要什么。'
    );
    expect(JSON.stringify(row)).not.toContain('反复回到同一件事');
  });

  it('snooze 7 天 ⇒ SNOOZED + snoozedUntil = now + 7 天，行不删', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    const got = await module.setReflectionStatus(USER, 'r1', { action: 'snooze', days: 7, now: NOW });
    expect(got.status).toBe('SNOOZED');
    expect(got.snoozedUntil).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    expect(reflectionTable().rows.has('r1')).toBe(true);
  });

  it('动作只从 PENDING 出发：第二次动作是 409，不是把已处理的行再改一遍', async () => {
    reflectionTable().seed(reflection('r1', { status: 'ACCEPTED', decidedAt: NOW }));
    const module = await service();
    await expect(module.setReflectionStatus(USER, 'r1', { action: 'accept', now: NOW })).rejects.toMatchObject(
      { status: 409 }
    );
  });

  it('读到的瞬间被另一个连接判掉了 ⇒ 条件更新命中 0 行，是 409 而不是覆盖（这条钉的是 where 里那个 status）', async () => {
    reflectionTable().seed(reflection('r1'));
    const table = reflectionTable();
    const realFindFirst = table.findFirst.bind(table);
    let flipped = false;
    table.findFirst = (args) => {
      const hit = realFindFirst(args);
      // 模拟交错：读回来的是 PENDING，条件更新之前另一条连接先把这行处置了。
      // 真库的交错由那一侧的行锁保证，这里能证明的只有「UPDATE 自己带状态条件，抢输了不会覆盖」。
      if (!flipped && args?.where?.id === 'r1') {
        flipped = true;
        table.rows.get('r1')!.status = 'ACCEPTED';
      }
      return hit;
    };
    const module = await service();
    await expect(module.setReflectionStatus(USER, 'r1', { action: 'reject', now: NOW })).rejects.toMatchObject({
      status: 409
    });
    expect(flipped).toBe(true);
    expect(table.rows.get('r1')!.status).toBe('ACCEPTED');
  });

  it('行不存在是 404，存在但别人的也是 404', async () => {
    reflectionTable().seed(reflection('r1', { userId: OTHER }));
    const module = await service();
    await expect(module.setReflectionStatus(USER, 'nope', { action: 'accept', now: NOW })).rejects.toMatchObject(
      { status: 404 }
    );
    await expect(module.setReflectionStatus(USER, 'r1', { action: 'accept', now: NOW })).rejects.toMatchObject(
      { status: 404 }
    );
  });

  it('读侧已经判成过期的行，动作同样不给做（409），否则界面和库里会各说一套', async () => {
    reflectionTable().seed(reflection('r1', { expiresAt: new Date(NOW.getTime() - DAY) }));
    const module = await service();
    await expect(module.setReflectionStatus(USER, 'r1', { action: 'accept', now: NOW })).rejects.toMatchObject({
      status: 409
    });
    expect(reflectionTable().rows.get('r1')!.status).toBe('PENDING');
  });

  it('改正文不接受空串：那是把洞察改成一条没有内容的话', async () => {
    reflectionTable().seed(reflection('r1'));
    const module = await service();
    await expect(
      module.setReflectionStatus(USER, 'r1', { action: 'edit', now: NOW, title: '   ', body: '甲' })
    ).rejects.toMatchObject({ status: 400 });
  });
});

function reflectionTable() {
  return buildTables().reflectionRecord;
}
function citationTable() {
  return buildTables().reflectionCitation;
}
function memoryTable() {
  return buildTables().memoryItem;
}
function decisionTable() {
  return buildTables().decisionRecord;
}
function preferenceTable() {
  return buildTables().cognitivePreference;
}
