import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSubject } from '@/lib/cognitive/reconsolidation';
import { createTable, type MockTable } from './prisma-mock';

/**
 * 再巩固检查（任务书 7.1「记忆被再次调用时，检查……」）。
 *
 * 任务书列了五项。这一片只做其中三项，另外两项**判为无法验收，不发明**：
 *
 * | 检查 | 今天有没有 | 这一片 |
 * |---|---|---|
 * | 是否出现了新的支持信息 | 有：证据行带 createdAt，写侧 recordRestatement 会补 SUPPORTS | 做 |
 * | 是否出现了新的反例 | **行**有（reviseMemory 写 CONTRADICTS），**发现**没有 | 只报库里已有的行 |
 * | 是否已经过时 | 全有，读侧：validTo / supersededAt | 做 |
 * | 是否需要更新摘要 | 记忆摘要这个东西不存在（MemoryItem 没有摘要列） | 不做 |
 * | 是否需要修改关联关系 | 关系表有了，但没有可自动判定的「该改哪条边」信号 | 不做 |
 *
 * 「词法反例发现」也不做，理由不是懒得做：docs/cognitive-acceptance.md:537-570 那次实测
 * 36 条候选 0 条真是反例，把那种匹配接进这一屏只会产出一排假警报。
 *
 * 所以检查本身是一个**纯函数**：输入是已经查回来的记忆列和证据条，输出是标记数组。
 * 它不算分、不排序、不碰数据库，因此也不可能有第二份评分规则。
 * 标记只回答「这条值得回看一下」，**不改变置信度**——置信度仍然只由 evidence.ts 那一份算。
 * 本文件里唯一的数据库读写是 `listEvidenceRows`，它按设计住在 evidence.ts（方向的映射只该有一份）。
 *
 * 测试：本文件。边界照旧：跑的是内存求值器不是 SQL。
 */
const tables = new Map<string, MockTable>();

function memoryEvidence(): MockTable {
  let table = tables.get('memoryEvidence');
  if (!table) {
    table = createTable({
      defaults: () => ({ noteCiphertext: null, sourceChatId: null, sourceMessageId: null })
    });
    tables.set('memoryEvidence', table);
  }
  return table;
}

vi.mock('@/lib/prisma', () => ({ prisma: { memoryEvidence: memoryEvidence() } }));

const USER = 'user-a';
const OTHER = 'user-b';
const RECORDED = '2026-11-01T10:00:00.000Z';
const NOW = new Date('2026-11-05T10:00:00.000Z');

async function reconsolidation() {
  return await import('@/lib/cognitive/reconsolidation');
}

function subject(overrides: Partial<ReviewSubject> = {}): ReviewSubject {
  return {
    id: 'mem-1',
    origin: 'explicit',
    recordedAt: RECORDED,
    validTo: null,
    supersededAt: null,
    archivedAt: null,
    ...overrides
  };
}

function stamp(kind: 'supports' | 'contradicts', createdAt: string) {
  return { kind, createdAt };
}

beforeEach(() => {
  memoryEvidence().rows.clear();
});

describe('新的支持信息', () => {
  it('记下来之后又出现的支持证据 ⇒ newSupport', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(
      reviewMemory(subject(), [stamp('supports', '2026-11-03T08:00:00.000Z')], NOW)
    ).toEqual(['newSupport']);
  });

  it('创建时那一条支持证据不算「新的」：它本来就在，时间等于 recordedAt', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject(), [stamp('supports', RECORDED)], NOW)).toEqual([]);
  });

  it('比 recordedAt 更早的支持证据不算新的', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(
      reviewMemory(subject(), [stamp('supports', '2026-10-31T10:00:00.000Z')], NOW)
    ).toEqual([]);
  });

  it('反例不是支持信息：只有 supports 方向能产这个标记', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject(), [stamp('contradicts', '2026-11-03T08:00:00.000Z')], NOW)).not.toContain(
      'newSupport'
    );
  });
});

describe('新的反例', () => {
  it('库里已有的 CONTRADICTS 行 ⇒ contradiction，不看时间——新说法本身就是反例', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(
      reviewMemory(subject(), [stamp('supports', RECORDED), stamp('contradicts', '2026-11-02T08:00:00.000Z')], NOW)
    ).toEqual(['contradiction']);
  });

  it('一条已有的反例都没有就不报——这一项只报库里真的有的东西', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject(), [stamp('supports', '2026-11-03T08:00:00.000Z')], NOW)).not.toContain(
      'contradiction'
    );
  });
});

describe('已经过时', () => {
  it('validTo 已过 ⇒ outdated', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject({ validTo: '2026-11-02T00:00:00.000Z' }), [], NOW)).toEqual(['outdated']);
  });

  it('validTo 还没到就不算过时', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject({ validTo: '2027-01-01T00:00:00.000Z' }), [], NOW)).toEqual([]);
  });

  it('validTo 恰好等于此刻算过时——和 confidence.ts 的 <= 同一口径，不留两处不一样', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(reviewMemory(subject({ validTo: NOW.toISOString() }), [], NOW)).toEqual(['outdated']);
  });
});

describe('标记的形状', () => {
  it('三项同时成立时顺序固定，界面不必自己排', async () => {
    const { reviewMemory } = await reconsolidation();

    expect(
      reviewMemory(
        subject({ validTo: '2026-11-02T00:00:00.000Z' }),
        [stamp('supports', '2026-11-03T08:00:00.000Z'), stamp('contradicts', '2026-11-04T08:00:00.000Z')],
        NOW
      )
    ).toEqual(['newSupport', 'contradiction', 'outdated']);
  });

  it('已经走完的记忆不产任何标记：被取代、归档、撤回三种终态一视同仁', async () => {
    const { reviewMemory } = await reconsolidation();
    const later = [stamp('supports', '2026-11-03T08:00:00.000Z'), stamp('contradicts', '2026-11-04T08:00:00.000Z')];

    expect(reviewMemory(subject({ supersededAt: '2026-11-02T00:00:00.000Z' }), later, NOW)).toEqual([]);
    expect(reviewMemory(subject({ archivedAt: '2026-11-02T00:00:00.000Z' }), later, NOW)).toEqual([]);
    expect(reviewMemory(subject({ origin: 'retracted' }), later, NOW)).toEqual([]);
  });

  it('一批记忆一次算完：证据缺席的按空数组回，不是从结果里消失', async () => {
    const { reviewMemories } = await reconsolidation();

    const reviews = reviewMemories(
      [subject({ id: 'mem-1' }), subject({ id: 'mem-2', validTo: '2026-11-01T00:00:00.000Z' }), subject({ id: 'mem-3' })],
      new Map([['mem-1', [stamp('supports', '2026-11-03T08:00:00.000Z')]]]),
      NOW
    );

    expect([...reviews.keys()]).toEqual(['mem-1', 'mem-2', 'mem-3']);
    expect(reviews.get('mem-1')).toEqual(['newSupport']);
    expect(reviews.get('mem-2')).toEqual(['outdated']);
    expect(reviews.get('mem-3')).toEqual([]);
  });

  it('标签恰好三项，且没有「需要更新摘要」「需要修改关联关系」这两项——不发明没有实现的东西', async () => {
    const { RECONSOLIDATION_LABELS } = await import('@/lib/cognitive/memory-display');

    expect(Object.keys(RECONSOLIDATION_LABELS).sort()).toEqual(['contradiction', 'newSupport', 'outdated']);
    for (const label of Object.values(RECONSOLIDATION_LABELS)) {
      expect(label).not.toMatch(/摘要|关联关系/);
    }
  });

  it('证据再多也只产这三项：第四条凭据不会换来一个「要更新摘要」', async () => {
    // 「需要更新摘要」这一项判的是无法验收（MemoryItem 没有摘要列），所以它既不该进标签表，
    // 也不该由这个函数产出来。上面那条守的是表，这一条守的是产标记的那只手——
    // 只钉表的话，多产一个没标签的标记会让界面渲染出 undefined。
    const { reviewMemory } = await reconsolidation();
    const many = [
      stamp('supports', '2026-11-02T08:00:00.000Z'),
      stamp('supports', '2026-11-03T08:00:00.000Z'),
      stamp('supports', '2026-11-04T08:00:00.000Z'),
      stamp('contradicts', '2026-11-04T09:00:00.000Z')
    ];

    expect(reviewMemory(subject(), many, NOW)).toEqual(['newSupport', 'contradiction']);
  });
});

/**
 * 证据的批量读。标记是读时算的，所以每屏一次查询而不是每条记忆一次：
 * 注入 8 条记忆就是 8 次往返，而这一屏本来就在算置信度的同一次 groupBy 旁边。
 * 这个读留在 evidence.ts——方向的映射（SUPPORTS ↔ supports）那份证据账本已经有了，不该有第二份。
 */
describe('证据的批量读', () => {
  async function evidence() {
    return await import('@/lib/cognitive/evidence');
  }

  async function seed(rows: Array<{ userId: string; memoryId: string; kind: string; createdAt: Date }>) {
    for (const row of rows) {
      memoryEvidence().seed({ id: `ev-${memoryEvidence().rows.size + 1}`, ...row });
    }
  }

  it('一次查回一批记忆的证据，只带 kind 与 createdAt', async () => {
    const { listEvidenceRows } = await evidence();
    await seed([
      { userId: USER, memoryId: 'mem-1', kind: 'SUPPORTS', createdAt: new Date('2026-11-02T00:00:00.000Z') },
      { userId: USER, memoryId: 'mem-1', kind: 'CONTRADICTS', createdAt: new Date('2026-11-03T00:00:00.000Z') },
      { userId: USER, memoryId: 'mem-2', kind: 'SUPPORTS', createdAt: new Date('2026-11-04T00:00:00.000Z') }
    ]);

    const rows = await listEvidenceRows(USER, ['mem-1', 'mem-2']);

    expect(rows.map((row) => [row.memoryId, row.kind, row.createdAt])).toEqual([
      ['mem-1', 'supports', '2026-11-02T00:00:00.000Z'],
      ['mem-1', 'contradicts', '2026-11-03T00:00:00.000Z'],
      ['mem-2', 'supports', '2026-11-04T00:00:00.000Z']
    ]);
  });

  it('别人的证据一条也不带：memoryId 撞上了也不算', async () => {
    const { listEvidenceRows } = await evidence();
    await seed([
      { userId: OTHER, memoryId: 'mem-1', kind: 'CONTRADICTS', createdAt: new Date('2026-11-03T00:00:00.000Z') }
    ]);

    await expect(listEvidenceRows(USER, ['mem-1'])).resolves.toEqual([]);
  });

  it('没有记忆要查时不发查询', async () => {
    const { listEvidenceRows } = await evidence();
    await seed([{ userId: USER, memoryId: 'mem-1', kind: 'SUPPORTS', createdAt: new Date() }]);

    await expect(listEvidenceRows(USER, [])).resolves.toEqual([]);

    expect(memoryEvidence().rows.size).toBe(1);
  });
});
