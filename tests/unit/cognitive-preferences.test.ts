import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 认知引擎的三个模块必须各自能被单个用户打开或关掉，且默认全关——
 * 「没有这一行记录」和「记录里全是 false」必须等价，否则新上线的表会把陌生用户的
 * 记忆功能当成开着。这一组用例同时钉住隔离：所有读写都以 userId 为主键。
 */
const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  reads: [] as Array<Record<string, unknown>>
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cognitivePreference: {
      findUnique: ({ where }: { where: { userId: string } }) => {
        db.reads.push(where);
        return Promise.resolve((db.rows.get(where.userId) as object | undefined) ?? null);
      },
      upsert: ({ where, create, update }: { where: { userId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = db.rows.get(where.userId);
        const next = existing ? { ...existing, ...update } : { ...create };
        db.rows.set(where.userId, next);
        return Promise.resolve(next);
      }
    }
  }
}));

const USER_A = 'user-a';
const USER_B = 'user-b';

/** 任务书 1.1 的八个开关。adaptiveMemory 是策略层的，不对应一个会读写的模块。 */
const ALL_SWITCHES = [
  'memoryEnabled',
  'userModelEnabled',
  'emotionEnabled',
  'associationEnabled',
  'timelineEnabled',
  'reflectionEnabled',
  'decisionMemoryEnabled',
  'adaptiveMemoryEnabled'
] as const;

async function prefs() {
  return await import('@/lib/cognitive/preferences');
}

beforeEach(() => {
  db.rows.clear();
  db.reads = [];
});

describe('认知模块开关', () => {
  it('库里没有记录时，八个开关都算关着', async () => {
    const { getCognitivePreferences } = await prefs();

    const preferences = await getCognitivePreferences(USER_A);

    expect(preferences).toMatchObject({
      memoryEnabled: false,
      userModelEnabled: false,
      emotionEnabled: false,
      associationEnabled: false,
      timelineEnabled: false,
      reflectionEnabled: false,
      decisionMemoryEnabled: false,
      adaptiveMemoryEnabled: false,
      emotionTransparency: 'implicit'
    });
    for (const key of ALL_SWITCHES) expect(preferences[key]).toBe(false);
  });

  it('只打开记忆模块，画像与情感保持关闭', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();

    await updateCognitivePreferences(USER_A, { memoryEnabled: true });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({
      memoryEnabled: true,
      userModelEnabled: false,
      emotionEnabled: false
    });
  });

  it('每个开关各自独立：打开任意一个都不会顺带打开别的', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();

    for (const key of ALL_SWITCHES) {
      db.rows.clear();
      await updateCognitivePreferences(USER_A, { [key]: true });
      const preferences = await getCognitivePreferences(USER_A);
      const on = ALL_SWITCHES.filter((name) => preferences[name]);
      expect(on).toEqual([key]);
    }
  });

  it('改情感透明度不会顺手把开关重置掉', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();
    await updateCognitivePreferences(USER_A, { memoryEnabled: true, emotionEnabled: true });

    await updateCognitivePreferences(USER_A, { emotionTransparency: 'explicit' });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({
      memoryEnabled: true,
      emotionEnabled: true,
      emotionTransparency: 'explicit'
    });
  });

  it('关掉模块只改开关，不动其它用户的数据', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();
    await updateCognitivePreferences(USER_A, { memoryEnabled: true });
    await updateCognitivePreferences(USER_B, { userModelEnabled: true });

    await updateCognitivePreferences(USER_A, { memoryEnabled: false });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({ memoryEnabled: false, userModelEnabled: false });
    expect(await getCognitivePreferences(USER_B)).toMatchObject({ userModelEnabled: true });
  });

  it('读写的 where 里必须带上调用者自己的 userId', async () => {
    const { getCognitivePreferences } = await prefs();

    await getCognitivePreferences(USER_A);

    expect(db.reads).toEqual([{ userId: USER_A }]);
  });
});
