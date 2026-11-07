import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryDto } from '@/lib/cognitive/memories';

/**
 * 记忆巩固（Phase 3）。钉安全边界：只并同 type+context 且高度重合的，换值/跨项目不并；
 * 保留最新为主，其余可逆归档连证据边；默认关、坏了不抛。
 */
const ctx = vi.hoisted(() => ({
  memories: [] as MemoryDto[],
  archived: [] as string[],
  edges: [] as Array<{ primaryMemoryId: string; memberMemoryId: string }>,
  listThrows: false
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/logger', () => ({
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}));
vi.mock('@/lib/cognitive/memories', () => ({
  listMemories: () => (ctx.listThrows ? Promise.reject(new Error('db down')) : Promise.resolve(ctx.memories)),
  archiveMemory: (id: string) => {
    ctx.archived.push(id);
    return Promise.resolve(true);
  }
}));
vi.mock('@/lib/cognitive/relations', () => ({
  recordConsolidationRelation: (_tx: unknown, input: { primaryMemoryId: string; memberMemoryId: string }) => {
    ctx.edges.push(input);
    return Promise.resolve();
  }
}));

function row(overrides: Partial<MemoryDto> & { id: string; content: string }): MemoryDto {
  return {
    chatId: null,
    sourceMessageId: null,
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    confirmedAt: null,
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  } as MemoryDto;
}

async function mod() {
  return await import('@/lib/cognitive/memory-consolidator');
}

afterEach(() => {
  ctx.memories = [];
  ctx.archived = [];
  ctx.edges = [];
  ctx.listThrows = false;
  delete process.env.COGNITIVE_MEMORY_CONSOLIDATION;
});

describe('findConsolidationGroups：聚类的安全边界', () => {
  it('同 type+context 且几乎同义的聚成一簇，最新排第一', async () => {
    const { findConsolidationGroups } = await mod();
    const groups = findConsolidationGroups([
      row({ id: 'old', content: '我住在杭州西湖区', recordedAt: '2026-11-01T00:00:00.000Z' }),
      row({ id: 'new', content: '我住在杭州西湖区。', recordedAt: '2026-11-02T00:00:00.000Z' })
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('换值的不并：我住北京 和 我住上海 并存', async () => {
    const { findConsolidationGroups } = await mod();
    expect(findConsolidationGroups([row({ id: 'a', content: '我住北京' }), row({ id: 'b', content: '我住上海' })])).toEqual([]);
  });

  it('跨 type 或跨 context 绝不合并', async () => {
    const { findConsolidationGroups } = await mod();
    const sameText = '我在做智能小车项目';
    expect(findConsolidationGroups([
      row({ id: 'a', content: sameText, type: 'project' }),
      row({ id: 'b', content: sameText, type: 'fact' })
    ])).toEqual([]);
    expect(findConsolidationGroups([
      row({ id: 'a', content: sameText, context: 'general' }),
      row({ id: 'b', content: sameText, context: 'technicalProject' })
    ])).toEqual([]);
  });

  it('单条不成簇', async () => {
    const { findConsolidationGroups } = await mod();
    expect(findConsolidationGroups([row({ id: 'a', content: '我住在杭州西湖区' })])).toEqual([]);
  });
});

describe('runMemoryConsolidation：后台运行', () => {
  it('默认关时一个库都不读', async () => {
    const { runMemoryConsolidation } = await mod();
    ctx.memories = [row({ id: 'a', content: '我住在杭州西湖区' }), row({ id: 'b', content: '我住在杭州西湖区。' })];
    const outcome = await runMemoryConsolidation('user-a');
    expect(outcome).toEqual({ groups: 0, archived: 0 });
    expect(ctx.archived).toEqual([]);
  });

  it('开着时归档冗余旧条、连 PART_OF 证据边，保留最新', async () => {
    process.env.COGNITIVE_MEMORY_CONSOLIDATION = '1';
    const { runMemoryConsolidation } = await mod();
    ctx.memories = [
      row({ id: 'old', content: '我住在杭州西湖区', recordedAt: '2026-11-01T00:00:00.000Z' }),
      row({ id: 'new', content: '我住在杭州西湖区。', recordedAt: '2026-11-02T00:00:00.000Z' })
    ];
    const outcome = await runMemoryConsolidation('user-a');
    expect(outcome).toEqual({ groups: 1, archived: 1 });
    expect(ctx.archived).toEqual(['old']);
    expect(ctx.edges).toMatchObject([{ primaryMemoryId: 'new', memberMemoryId: 'old' }]);
  });

  it('读库失败不抛给 worker，返回零计数', async () => {
    process.env.COGNITIVE_MEMORY_CONSOLIDATION = '1';
    const { runMemoryConsolidation } = await mod();
    ctx.listThrows = true;
    await expect(runMemoryConsolidation('user-a')).resolves.toEqual({ groups: 0, archived: 0 });
  });
});