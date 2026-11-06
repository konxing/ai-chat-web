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
      emotionTransparency: 'implicit',
      memoryWritePaused: false
    });
    for (const key of ALL_SWITCHES) expect(preferences[key]).toBe(false);
  });

  it('暂停写入不是第九个模块开关：八个开关还是八个，暂停不跟着把读一起关', async () => {
    const { COGNITIVE_FLAGS, updateCognitivePreferences, getCognitivePreferences } = await prefs();

    // 模块开关关掉后读侧也不注入；暂停只关写。塞进同一张表就等于把两件事合成一件。
    expect([...COGNITIVE_FLAGS]).toHaveLength(8);
    expect([...COGNITIVE_FLAGS]).not.toContain('memoryWritePaused');

    await updateCognitivePreferences(USER_A, { memoryEnabled: true });
    await updateCognitivePreferences(USER_A, { memoryWritePaused: true });

    const preferences = await getCognitivePreferences(USER_A);
    expect(preferences).toMatchObject({ memoryEnabled: true, memoryWritePaused: true });
  });

  it('暂停只改自己那一列：八个开关和情感透明度都保持原值', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();
    await updateCognitivePreferences(USER_A, {
      memoryEnabled: true,
      timelineEnabled: true,
      emotionTransparency: 'explicit'
    });

    await updateCognitivePreferences(USER_A, { memoryWritePaused: true });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({
      memoryEnabled: true,
      timelineEnabled: true,
      emotionTransparency: 'explicit',
      memoryWritePaused: true
    });
  });

  it('取消暂停是一次普通的改列：库里那一行回到 false，读侧不受影响', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();
    await updateCognitivePreferences(USER_A, { memoryEnabled: true, memoryWritePaused: true });

    await updateCognitivePreferences(USER_A, { memoryWritePaused: false });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({
      memoryEnabled: true,
      memoryWritePaused: false
    });
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

/**
 * 任务书 6.6 :722「建议对同一主题建立去重键，并设置可配置的冷却规则」。
 * 去重键早就在了（`dedupKey` 加库层 `@@unique([userId, dedupKey])`），缺的是后一半：
 * 扫描节奏今天写死在 `REFLECTION_SWEEP_COOLDOWN_HOURS = 24`，用户改不动。
 *
 * 这一组只钉「档位进了偏好，而且进的时候没把别的东西顺手动掉」。最关键的是**默认档必须等于
 * 今天那一档**：加一个设置项若同时改了所有现存用户的节奏，那就不是设置，是一次偷偷的行为变更
 * ——和片 7.2 那次「归档不许改动读侧」同一条立场。
 */
describe('反思生成节奏（6.6 的可配置冷却）', () => {
  it('库里没有记录 ⇒ 默认每天，就是今天写死的那一档，不因新增设置项而改行为', async () => {
    const { getCognitivePreferences } = await prefs();

    const preferences = await getCognitivePreferences(USER_A);

    expect(preferences.reflectionCooldown).toBe('daily');
  });

  it('三档各自往返：对外小写、库里大写枚举，和 emotionTransparency 同一套口径', async () => {
    const { updateCognitivePreferences } = await prefs();

    await updateCognitivePreferences(USER_A, { reflectionCooldown: 'weekly' });
    expect(db.rows.get(USER_A)!.reflectionCooldown).toBe('WEEKLY');

    await updateCognitivePreferences(USER_A, { reflectionCooldown: 'monthly' });
    expect(db.rows.get(USER_A)!.reflectionCooldown).toBe('MONTHLY');

    const { getCognitivePreferences } = await prefs();
    expect((await getCognitivePreferences(USER_A)).reflectionCooldown).toBe('monthly');
  });

  it('只改节奏 ⇒ 八个开关、情感透明度和暂停写入一个都不动', async () => {
    const { updateCognitivePreferences, getCognitivePreferences } = await prefs();
    await updateCognitivePreferences(USER_A, {
      memoryEnabled: true,
      reflectionEnabled: true,
      emotionTransparency: 'explicit',
      memoryWritePaused: true
    });

    await updateCognitivePreferences(USER_A, { reflectionCooldown: 'weekly' });

    expect(await getCognitivePreferences(USER_A)).toMatchObject({
      memoryEnabled: true,
      reflectionEnabled: true,
      emotionTransparency: 'explicit',
      memoryWritePaused: true,
      reflectionCooldown: 'weekly'
    });
  });

  it('节奏是一列设置，不是第九个开关：八个开关的名单里不许出现它', async () => {
    const { COGNITIVE_FLAGS } = await prefs();

    expect(COGNITIVE_FLAGS).toHaveLength(8);
    expect(COGNITIVE_FLAGS).not.toContain('reflectionCooldown');
  });
});
