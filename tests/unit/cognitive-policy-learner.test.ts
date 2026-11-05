import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MemoryPolicyLearner（任务书 1.3 反馈学习）。
 *
 * 钉住的是那几条禁令，而不是「学习生效了」这一件好事：
 * 一、只认明确操作。这里只有「永久删除」算证据——撤回不算（用户可能只是想让它别再用，
 *    不是抱怨这个情境记太多），改记忆更不算（那是想让它记对）。
 * 二、不同情境分别学。技术项目里删了三条，不许顺手把私人倾诉也收紧。
 * 三、先生成候选、达到规定证据条件才生效。三次、30 天窗口，差一条都不动。
 * 四、只往更保守的方向走。学习层永远不会替用户把权限打开。
 * 五、用户亲手改过的情境，学习层不再碰。否则用户改回宽松、它下一轮又改严，
 *    就是在和用户抢方向盘——任务书最后一句禁止的正是这种凌驾。
 *
 * 这里跑的是真的 policy.ts（只 mock prisma）：学习层要改的就是策略行本身，
 * 把 policy 也 mock 掉就只剩一层壳可测了。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  policies: new Map<string, Row>(),
  signals: [] as Row[],
  tick: 0,
  /** 偏好表里的第八个开关。null 表示「偏好读不出来」。 */
  adaptiveEnabled: true as boolean | null
}));

function policyKey(userId: string, context: string) {
  return `${userId}|${context}`;
}

function satisfies(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== 'object') return value === condition;
  const c = condition as Record<string, unknown>;
  if ('in' in c) return (c.in as unknown[]).includes(value);
  if ('gte' in c) return (value as Date).getTime() >= (c.gte as Date).getTime();
  return value === condition;
}

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where as Record<string, unknown>).every(([field, condition]) =>
    satisfies(row[field], condition)
  );
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    memoryPolicy: {
      findMany: ({ where }: { where: { userId: string } }) =>
        Promise.resolve([...db.policies.values()].filter((row) => row.userId === where.userId).map((row) => ({ ...row }))),
      findFirst: ({ where }: { where: unknown }) => {
        const row = [...db.policies.values()].filter((candidate) => matches(candidate, where))[0];
        return Promise.resolve(row ? { ...row } : null);
      },
      upsert: ({
        where,
        create,
        update
      }: {
        where: { userId_context: { userId: string; context: string } };
        create: Row;
        update: Row;
      }) => {
        const key = policyKey(where.userId_context.userId, where.userId_context.context);
        const existing = db.policies.get(key);
        const next = existing ? { ...existing, ...update } : { ...create };
        db.policies.set(key, next);
        return Promise.resolve({ ...next });
      },
      deleteMany: ({ where }: { where: unknown }) => {
        const rows = [...db.policies.values()].filter((row) => matches(row, where));
        for (const row of rows) db.policies.delete(policyKey(String(row.userId), String(row.context)));
        return Promise.resolve({ count: rows.length });
      }
    },
    memoryPolicySignal: {
      create: ({ data }: { data: Row }) => {
        const row: Row = { createdAt: new Date(Date.now() + (db.tick += 1)), ...data };
        db.signals.push(row);
        return Promise.resolve(row);
      },
      count: ({ where }: { where: unknown }) => Promise.resolve(db.signals.filter((row) => matches(row, where)).length),
      deleteMany: ({ where }: { where: unknown }) => {
        const rows = db.signals.filter((row) => matches(row, where));
        db.signals = db.signals.filter((row) => !rows.includes(row));
        return Promise.resolve({ count: rows.length });
      }
    },
    // 闸门在事务之外读一次偏好；null 让 getCognitivePreferences 走到「读不出来」那一支。
    cognitivePreference: {
      findUnique: () =>
        db.adaptiveEnabled === null
          ? Promise.reject(new Error('preference unavailable'))
          : Promise.resolve({ adaptiveMemoryEnabled: db.adaptiveEnabled })
    }
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';
const DAY_MS = 24 * 60 * 60 * 1000;

type Context = 'general' | 'technicalProject' | 'decisionMaking' | 'emotionalSupport';

async function learner() {
  return await import('@/lib/cognitive/policy-learner');
}

async function policy() {
  return await import('@/lib/cognitive/policy');
}

/** 记一条信号并跑一次学习，模拟「用户永久删除了一条这个情境的记忆」。 */
async function purgeOnce(userId: string, context: Context) {
  const { recordPolicySignal, learnFromSignals } = await learner();
  const { prisma } = await import('@/lib/prisma');
  // 真实现收的是事务客户端（信号要和删除同一个事务）；这里没有事务要测，直接把 prisma 当 tx 传。
  await recordPolicySignal(prisma as never, userId, context);
  return learnFromSignals(userId, context);
}

async function currentPolicy(context: Context) {
  const { getMemoryPolicy } = await policy();
  return getMemoryPolicy(USER, context);
}

beforeEach(() => {
  db.policies.clear();
  db.signals = [];
  db.tick = 0;
  db.adaptiveEnabled = true;
});

describe('证据只来自永久删除', () => {
  it('记一条信号：情境入库是大写枚举，并且只带 userId 和情境', async () => {
    const { recordPolicySignal } = await learner();
    const { prisma } = await import('@/lib/prisma');

    await recordPolicySignal(prisma as never, USER, 'technicalProject');

    expect(db.signals).toHaveLength(1);
    expect(db.signals[0]).toMatchObject({ userId: USER, context: 'TECHNICAL_PROJECT' });
  });

  it('信号里不含任何正文，只有情境和时间', async () => {
    const { recordPolicySignal } = await learner();
    const { prisma } = await import('@/lib/prisma');

    await recordPolicySignal(prisma as never, USER, 'general');

    expect(Object.keys(db.signals[0]!).sort()).toEqual(['context', 'createdAt', 'id', 'userId']);
  });
});

describe('达到证据条件才生效', () => {
  it('删两次不动策略', async () => {
    await purgeOnce(USER, 'technicalProject');
    const outcome = await purgeOnce(USER, 'technicalProject');

    expect(outcome).toMatchObject({ applied: false, reason: 'insufficient_evidence' });
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(false);
  });

  it('第三次删达到阈值，收紧成「先问再记」并记下学习时间', async () => {
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    const outcome = await purgeOnce(USER, 'technicalProject');

    expect(outcome).toMatchObject({ applied: true, reason: 'applied' });
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(true);
    const states = await (await learner()).getPolicyLearningStates(USER);
    expect(states.technicalProject.learnedAt).toBeTruthy();
    expect(states.technicalProject.manualOverrideAt).toBeNull();
  });

  it('窗口外的旧信号不算证据', async () => {
    const { recordPolicySignal, learnFromSignals } = await learner();
    const { prisma } = await import('@/lib/prisma');
    const stale = new Date(Date.now() - 31 * DAY_MS);
    for (let index = 0; index < 3; index += 1) {
      await recordPolicySignal(prisma as never, USER, 'technicalProject');
      db.signals[db.signals.length - 1]!.createdAt = stale;
    }

    const outcome = await learnFromSignals(USER, 'technicalProject');

    expect(outcome).toMatchObject({ applied: false, reason: 'insufficient_evidence' });
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(false);
  });

  it('第 30 天内的信号仍然算', async () => {
    const { recordPolicySignal, learnFromSignals } = await learner();
    const { prisma } = await import('@/lib/prisma');
    const fresh = new Date(Date.now() - 29 * DAY_MS);
    for (let index = 0; index < 3; index += 1) {
      await recordPolicySignal(prisma as never, USER, 'technicalProject');
      db.signals[db.signals.length - 1]!.createdAt = fresh;
    }

    await expect(learnFromSignals(USER, 'technicalProject')).resolves.toMatchObject({ applied: true });
  });

  it('别人的信号不算自己的证据', async () => {
    await purgeOnce(OTHER, 'technicalProject');
    await purgeOnce(OTHER, 'technicalProject');
    const outcome = await purgeOnce(USER, 'technicalProject');

    expect(outcome).toMatchObject({ applied: false, reason: 'insufficient_evidence' });
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(false);
  });
});

describe('只往更保守的方向走', () => {
  it('收紧只动 requireConfirmation，其余字段仍是内置默认，一个都不许被放宽', async () => {
    const { DEFAULT_MEMORY_POLICIES } = await policy();

    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    const after = await currentPolicy('technicalProject');
    const defaults = DEFAULT_MEMORY_POLICIES.technicalProject;

    // 先确认这一条确实是被学习改的，不是本来就这样
    expect(defaults.requireConfirmation).toBe(false);
    expect(after.requireConfirmation).toBe(true);
    expect(after.allowPersistence).toBe(defaults.allowPersistence);
    expect(after.allowedMemoryTypes).toEqual(defaults.allowedMemoryTypes);
    expect(after.retention).toBe(defaults.retention);
    expect(after.allowUserProfile).toBe(defaults.allowUserProfile);
    expect(after.allowReflection).toBe(defaults.allowReflection);
    expect(after.allowAssociation).toBe(defaults.allowAssociation);
  });

  it('本来就是「先问再记」的情境，证据够了也不做任何改动，也不盖学习时间', async () => {
    await purgeOnce(USER, 'decisionMaking');
    await purgeOnce(USER, 'decisionMaking');
    const outcome = await purgeOnce(USER, 'decisionMaking');

    expect(outcome).toMatchObject({ applied: false, reason: 'already_conservative' });
    const states = await (await learner()).getPolicyLearningStates(USER);
    expect(states.decisionMaking.learnedAt).toBeNull();
  });

  it('已经收紧过的情境不重复应用', async () => {
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');

    const again = await purgeOnce(USER, 'technicalProject');

    expect(again).toMatchObject({ applied: false, reason: 'already_learned' });
  });
});

describe('分情境学习', () => {
  it('技术项目里删三次，日常和情绪支持一律不动', async () => {
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');

    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(true);
    expect((await currentPolicy('general')).requireConfirmation).toBe(false);
    // 敏感情境的内置默认本来就是全关，学习层不去碰它
    expect((await currentPolicy('emotionalSupport')).allowPersistence).toBe(false);
  });
});

describe('用户亲手改过就不许再学', () => {
  it('手动接管之后，证据再多也不动策略', async () => {
    const { updateMemoryPolicy } = await policy();
    await updateMemoryPolicy(USER, 'technicalProject', { requireConfirmation: false });

    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    const outcome = await purgeOnce(USER, 'technicalProject');

    expect(outcome).toMatchObject({ applied: false, reason: 'manual_override' });
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(false);
  });

  it('用户亲手改策略时留下接管时间', async () => {
    const { updateMemoryPolicy } = await policy();
    await updateMemoryPolicy(USER, 'general', { retention: 'days30' });

    const states = await (await learner()).getPolicyLearningStates(USER);
    expect(states.general.manualOverrideAt).toBeTruthy();
  });

  it('恢复默认把接管标记和学习记录一起清掉，信号也清掉', async () => {
    const { updateMemoryPolicy, resetMemoryPolicy } = await policy();
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'technicalProject');
    await updateMemoryPolicy(USER, 'technicalProject', { retention: 'days30' });
    expect(db.signals.length).toBe(3);

    await resetMemoryPolicy(USER, 'technicalProject');

    expect(db.signals).toEqual([]);
    const states = await (await learner()).getPolicyLearningStates(USER);
    expect(states.technicalProject).toEqual({ learnedAt: null, manualOverrideAt: null });
  });

  it('恢复默认只清这个情境的信号，别的情境的证据留着', async () => {
    const { resetMemoryPolicy } = await policy();
    await purgeOnce(USER, 'technicalProject');
    await purgeOnce(USER, 'general');

    await resetMemoryPolicy(USER, 'technicalProject');

    expect(db.signals).toHaveLength(1);
    expect(db.signals[0]).toMatchObject({ context: 'GENERAL' });
  });
});

describe('开关关了就不学（任务书 7.4 门槛 9 的策略学习层）', () => {
  /**
   * 只攒证据、不跑学习：purgeOnce 里那步 learnFromSignals 会把策略当场收紧，
   * 用它就没法证明收紧是闸门放开之后 learnAfterSignals 干的了。
   */
  async function threeSignals(userId: string, context: Context) {
    const { recordPolicySignal } = await learner();
    const { prisma } = await import('@/lib/prisma');
    for (let i = 0; i < 3; i += 1) await recordPolicySignal(prisma as never, userId, context);
  }

  it('关掉之后 learnAfterSignals 返回空，证据够了也不收紧策略', async () => {
    db.adaptiveEnabled = false;
    await threeSignals(USER, 'technicalProject');
    const { learnAfterSignals } = await learner();

    const learned = await learnAfterSignals(USER, ['technicalProject']);

    expect(learned).toEqual([]);
    expect(db.policies.size).toBe(0);
  });

  it('开着才照旧收紧：同样的三条证据，learnAfterSignals 报出被改的情境', async () => {
    await threeSignals(USER, 'technicalProject');
    const { learnAfterSignals } = await learner();

    const learned = await learnAfterSignals(USER, ['technicalProject']);

    expect(learned).toEqual(['technicalProject']);
    expect((await currentPolicy('technicalProject')).requireConfirmation).toBe(true);
  });

  it('偏好读不出来当关：什么都不学，也不要把错误冒到删除链路上', async () => {
    db.adaptiveEnabled = null;
    await threeSignals(USER, 'general');
    const { learnAfterSignals } = await learner();

    await expect(learnAfterSignals(USER, ['general'])).resolves.toEqual([]);
    expect(db.policies.size).toBe(0);
  });
});

describe('没配过策略行的用户', () => {
  it('内置默认就是学习层的起点，收紧时按默认值建行', async () => {
    await purgeOnce(USER, 'general');
    await purgeOnce(USER, 'general');
    await purgeOnce(USER, 'general');

    expect(db.policies.size).toBe(1);
    const stored = [...db.policies.values()][0]!;
    expect(stored).toMatchObject({ userId: USER, context: 'GENERAL', requireConfirmation: true });
    // 其余字段必须等于内置默认，不许因为建行而放宽或收紧别的什么
    expect(stored.allowPersistence).toBe(true);
    expect(stored.retention).toBe('FOREVER');
  });
});
