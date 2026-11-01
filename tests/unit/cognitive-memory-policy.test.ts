import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 任务书 1.2 的要点是「不要让系统无条件记住所有重要信息」：同一个用户在不同情境下
 * 应该得到不同的记忆策略，而私人倾诉和技术项目尤其不能共用一套。这里钉三件事——
 * 七种情境都有内置默认、用户改动只影响他自己那一行那一个情境、以及读取不会因为
 * 「还没配过」就退化成没有默认。
 */
const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  writes: [] as Array<Record<string, unknown>>
}));

function key(userId: string, context: string) {
  return `${userId}|${context}`;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    memoryPolicy: {
      findMany: ({ where }: { where: { userId: string } }) => {
        db.reads.push(where.userId);
        const rows = [...db.rows.values()].filter((row) => row.userId === where.userId);
        return Promise.resolve(rows);
      },
      upsert: ({
        where,
        create,
        update
      }: {
        where: { userId_context: { userId: string; context: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const id = key(where.userId_context.userId, where.userId_context.context);
        const existing = db.rows.get(id);
        const next = existing ? { ...existing, ...update } : { ...create };
        db.rows.set(id, next);
        db.writes.push(next);
        return Promise.resolve(next);
      },
      deleteMany: ({ where }: { where: { userId: string; context: string } }) => {
        for (const id of [...db.rows.keys()]) {
          if (id === key(where.userId, where.context)) db.rows.delete(id);
        }
        return Promise.resolve({ count: 1 });
      }
    }
  }
}));

const USER = 'user-a';
const CONTEXTS = [
  'general',
  'technicalProject',
  'learning',
  'personalGoal',
  'personalReflection',
  'emotionalSupport',
  'decisionMaking'
] as const;

async function policy() {
  return await import('@/lib/cognitive/policy');
}

beforeEach(() => {
  db.rows.clear();
  db.reads = [];
  db.writes = [];
});

describe('七情境记忆策略的默认值', () => {
  it('七种情境都有内置默认，库里没配过也能读出来', async () => {
    const { getMemoryPolicies } = await policy();

    const policies = await getMemoryPolicies(USER);

    expect(Object.keys(policies).sort()).toEqual([...CONTEXTS].sort());
    for (const context of CONTEXTS) {
      expect(policies[context].context).toBe(context);
      expect(Array.isArray(policies[context].allowedMemoryTypes)).toBe(true);
    }
    expect(db.reads).toEqual([USER]);
  });

  it('私人倾诉和情绪支持默认不落长期库，也不需要用户逐个确认', async () => {
    const { getMemoryPolicies } = await policy();

    const policies = await getMemoryPolicies(USER);

    for (const context of ['personalReflection', 'emotionalSupport'] as const) {
      expect(policies[context].allowPersistence).toBe(false);
      expect(policies[context].retention).toBe('sessionOnly');
      // 既然不持久化，「保存前要不要问」就不该再多问一次——两件事同时发生会打断倾诉。
      expect(policies[context].requireConfirmation).toBe(false);
      expect(policies[context].allowUserProfile).toBe(false);
      expect(policies[context].allowReflection).toBe(false);
      expect(policies[context].allowAssociation).toBe(false);
      expect(policies[context].allowedMemoryTypes).not.toContain('emotion');
    }
  });

  it('技术项目和普通情境默认可以落库，情绪内容不在允许的类型里', async () => {
    const { getMemoryPolicies } = await policy();

    const policies = await getMemoryPolicies(USER);

    expect(policies.technicalProject.allowPersistence).toBe(true);
    expect(policies.general.allowPersistence).toBe(true);
    expect(policies.general.allowedMemoryTypes).not.toContain('emotion');
  });

  it('决策情境默认落库但必须先经用户确认', async () => {
    const { getMemoryPolicies } = await policy();

    expect(await getMemoryPolicies(USER).then((p) => p.decisionMaking)).toMatchObject({
      allowPersistence: true,
      requireConfirmation: true
    });
  });
});

describe('用户改策略', () => {
  it('改一个情境不影响另一个情境——这是「不同情境不同策略」的可执行版本', async () => {
    const { updateMemoryPolicy, getMemoryPolicies } = await policy();

    await updateMemoryPolicy(USER, 'technicalProject', { allowedMemoryTypes: ['fact', 'project', 'decision'] });

    const policies = await getMemoryPolicies(USER);
    expect(policies.technicalProject.allowedMemoryTypes).toEqual(['fact', 'project', 'decision']);
    expect(policies.general.allowedMemoryTypes).toContain('preference');
    expect(policies.emotionalSupport.allowPersistence).toBe(false);
  });

  it('打开情绪支持情境的持久化，只改这一行，其余字段保持原样', async () => {
    const { updateMemoryPolicy, getMemoryPolicies } = await policy();

    await updateMemoryPolicy(USER, 'emotionalSupport', { allowPersistence: true });

    const policies = await getMemoryPolicies(USER);
    expect(policies.emotionalSupport.allowPersistence).toBe(true);
    // 不偷偷联动：用户没说的字段一律不动，「持久化开了但保留策略还是 sessionOnly」
    // 这种组合交给写入决策按更保守的一方处理，而不是在这里改用户的另一个设置。
    expect(policies.emotionalSupport.retention).toBe('sessionOnly');
    expect(policies.emotionalSupport.requireConfirmation).toBe(false);
    expect(policies.personalReflection.allowPersistence).toBe(false);
  });

  it('只写用户改动的字段，重置后回到内置默认', async () => {
    const { updateMemoryPolicy, resetMemoryPolicy, getMemoryPolicies } = await policy();

    await updateMemoryPolicy(USER, 'learning', { retention: 'days30' });
    await resetMemoryPolicy(USER, 'learning');

    const policies = await getMemoryPolicies(USER);
    expect(policies.learning).toEqual((await getMemoryPolicies('other-user')).learning);
    expect(db.rows.size).toBe(0);
  });

  it('非法情境和非法记忆类型被拒，不落库', async () => {
    const { updateMemoryPolicy } = await policy();

    await expect(updateMemoryPolicy(USER, 'medical' as never, { allowPersistence: true })).rejects.toThrow();
    await expect(updateMemoryPolicy(USER, 'general', { allowedMemoryTypes: ['salary'] as never })).rejects.toThrow();
    expect(db.writes).toEqual([]);
  });

  it('读写都带上调用者自己的 userId，落库用大写枚举', async () => {
    const { updateMemoryPolicy } = await policy();

    await updateMemoryPolicy(USER, 'general', { requireConfirmation: true });

    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ userId: USER, context: 'GENERAL', requireConfirmation: true });
  });
});
