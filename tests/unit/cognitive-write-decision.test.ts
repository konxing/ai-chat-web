import { describe, expect, it, vi } from 'vitest';

/**
 * 写入决策（任务书 1.2 的后半段）：把「情境」和「该情境的策略」合成一个动作——
 * 落库、只活在当前会话、先问用户、还是干脆不要。
 *
 * 这一版只实现四个动作 WRITE / EPHEMERAL / ASK_CONFIRM / IGNORE。
 * UPDATE / LINK / DELETE 要先有已存在的记忆行才判断得了，等 Phase 2 的记忆表落地再接，
 * 这里不放假分支充数。
 *
 * 顺序是有意的：模块总开关 > 类型白名单 > 能否持久化 > 是否需要确认。
 * 类型不在白名单里表示用户连「这类内容」都不要，比「不持久化」更彻底，所以先 IGNORE。
 */
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

type Overrides = Partial<Record<string, Partial<import('@/lib/cognitive/policy').MemoryPolicy>>>;

async function planner(overrides: Overrides = {}) {
  const module = await import('@/lib/cognitive/write-decision');
  const { DEFAULT_MEMORY_POLICIES } = await import('@/lib/cognitive/policy');
  const policies = structuredClone(DEFAULT_MEMORY_POLICIES);
  for (const [context, patch] of Object.entries(overrides)) {
    if (!patch) continue;
    const key = context as keyof typeof policies;
    policies[key] = { ...policies[key], ...patch };
  }
  return { plan: module.planMemoryWrite, policies, conservative: module.mostConservativePolicy };
}

const ON = { memoryEnabled: true };

describe('写入决策', () => {
  it('长期记忆关掉时，任何情境都不产生持久化写入', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      memoryEnabled: false,
      memoryType: 'project',
      text: '这个 Prisma schema 迁移报错了，日志说外键冲突',
      policies
    });

    expect(result.decision).toBe('EPHEMERAL');
    expect(result.reason).toBe('module_off');
    expect(result.retention).toBe('sessionOnly');
    expect(result.allowUserProfile).toBe(false);
    expect(result.allowAssociation).toBe(false);
    expect(result.allowReflection).toBe(false);
  });

  it('情绪倾诉默认只活在当前会话，不进长期库', async () => {
    const { plan, policies } = await planner({
      emotionalSupport: { allowedMemoryTypes: ['emotion', 'fact'] }
    });

    const result = plan({
      ...ON,
      memoryType: 'emotion',
      text: '今天跟爸妈吵架了，心里特别委屈，晚上一直想哭',
      policies
    });

    expect(result.context).toBe('emotionalSupport');
    expect(result.decision).toBe('EPHEMERAL');
    expect(result.reason).toBe('no_persistence');
  });

  it('技术项目情境不保存情绪类型的内容——类型白名单先于持久化判断', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'emotion',
      text: '这个 bug 部署后又异常了，我气得想砸键盘，烦死了',
      policies
    });

    expect(result.decision).toBe('IGNORE');
    expect(result.reason).toBe('type_not_allowed');
  });

  it('普通情境的默认类型清单里也没有情绪，同样 IGNORE', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'emotion',
      text: '今天天气不错，晚饭吃了碗面条，就是有点不开心',
      policies
    });

    expect(result.context).toBe('general');
    expect(result.decision).toBe('IGNORE');
  });

  it('决策情境允许落库，但必须先经用户确认', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'decision',
      text: '这台显示器要不要买，预算两千，纠结值不值，等降价会不会更划算',
      policies
    });

    expect(result.context).toBe('decisionMaking');
    expect(result.decision).toBe('ASK_CONFIRM');
    expect(result.reason).toBe('needs_confirmation');
  });

  it('技术项目里的事实直接落库，并把保留期和三个下游许可带出来', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'project',
      text: '这个 Prisma schema 迁移报错了，日志说外键冲突，重新部署还是 bug',
      policies
    });

    expect(result.decision).toBe('WRITE');
    expect(result.reason).toBe('allowed');
    expect(result.retention).toBe('forever');
    expect(result.allowUserProfile).toBe(true);
    expect(result.allowAssociation).toBe(true);
    expect(result.allowReflection).toBe(true);
  });

  it('两种情境打平时采纳更保守的那一条策略', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'fact',
      text: '这个 bug 让我很难受',
      policies
    });

    // 词法上技术项目和情绪支持并列；技术项目允许落库，情绪支持不落库——取后者。
    expect(result.ambiguous).toBe(true);
    expect(result.context).toBe('emotionalSupport');
    expect(result.decision).toBe('EPHEMERAL');
  });

  it('用户改过策略之后，同一句话的结果跟着变', async () => {
    const { plan, policies } = await planner({
      emotionalSupport: { allowPersistence: true, allowedMemoryTypes: ['emotion', 'fact'], retention: 'days30' }
    });

    const result = plan({
      ...ON,
      memoryType: 'emotion',
      text: '今天跟爸妈吵架了，心里特别委屈，晚上一直想哭',
      policies
    });

    expect(result.decision).toBe('WRITE');
    expect(result.retention).toBe('days30');
    // 用户没打开画像和关联，落库也不等于可以拿去用。
    expect(result.allowUserProfile).toBe(false);
    expect(result.allowAssociation).toBe(false);
  });

  it('不持久化的内容不得进入画像、反思和关联', async () => {
    const { plan, policies } = await planner({
      personalReflection: { allowUserProfile: true, allowAssociation: true }
    });

    const result = plan({
      ...ON,
      memoryType: 'goal',
      text: '我是不是太没用了，为什么我总是把关系搞砸，活着到底有什么意义',
      policies
    });

    expect(result.context).toBe('personalReflection');
    expect(result.decision).toBe('EPHEMERAL');
    expect(result.allowUserProfile).toBe(false);
    expect(result.allowReflection).toBe(false);
    expect(result.allowAssociation).toBe(false);
  });

  it('「不落库」比「要先确认」更保守，「要先确认」比「允许直接写」更保守', async () => {
    const { policies, conservative } = await planner();

    expect(conservative(['decisionMaking', 'emotionalSupport'], policies).context).toBe('emotionalSupport');
    expect(conservative(['decisionMaking', 'general'], policies).context).toBe('decisionMaking');
    // 都允许直接落库时，类型清单更少、保留期更短的一方胜出。
    const learningTight = {
      ...policies,
      learning: { ...policies.learning, allowedMemoryTypes: ['goal'], retention: 'days30' }
    } satisfies typeof policies;
    expect(conservative(['general', 'learning'], learningTight).context).toBe('learning');
  });

  it('输入文本不会被写进决策结果', async () => {
    const { plan, policies } = await planner();

    const result = plan({
      ...ON,
      memoryType: 'fact',
      text: '这个 Prisma schema 迁移报错了，日志说外键冲突，重新部署还是 bug',
      policies
    });

    expect(JSON.stringify(result)).not.toContain('外键');
    expect(JSON.stringify(result)).not.toContain('Prisma');
  });
});

/**
 * Phase 1 的验收口径就这两句：关闭长期记忆不产生持久化写入；不同情境采用不同策略。
 * 单独列出来，是为了让验收条件本身有一条可重复执行的用例，而不是靠上面那些片段凑。
 */
describe('Phase 1 验收条件', () => {
  const SENTENCES: Record<string, string> = {
    general: '今天天气不错，晚饭吃了碗面条',
    technicalProject: '这个 Prisma schema 迁移报错了，日志说外键冲突，重新部署还是 bug',
    learning: '这门课程的教材太难，复习到半夜还是不会做练习题',
    personalGoal: '今年目标减肥十斤，每天早上六点早起打卡，把健身坚持下来',
    personalReflection: '我是不是太没用了，为什么我总是把关系搞砸，活着到底有什么意义',
    emotionalSupport: '今天跟爸妈吵架了，心里特别委屈，晚上一直想哭',
    decisionMaking: '这台显示器要不要买，预算两千，纠结值不值，等降价会不会更划算'
  };

  it('关掉长期记忆后，七种情境没有任何一种产生持久化写入', async () => {
    const { plan, policies } = await planner();

    for (const [context, text] of Object.entries(SENTENCES)) {
      for (const memoryType of ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'] as const) {
        const result = plan({ memoryEnabled: false, memoryType, text, policies });
        expect(`${context}/${memoryType}:${result.decision}`).toBe(`${context}/${memoryType}:EPHEMERAL`);
        expect(result.retention).toBe('sessionOnly');
        expect(result.allowUserProfile).toBe(false);
        expect(result.allowReflection).toBe(false);
        expect(result.allowAssociation).toBe(false);
      }
    }
  });

  it('默认策略下，同样的候选类型在不同情境里得到不同动作', async () => {
    const { plan, policies } = await planner();

    const technical = plan({ ...ON, memoryType: 'fact', text: SENTENCES.technicalProject, policies });
    const emotional = plan({ ...ON, memoryType: 'fact', text: SENTENCES.emotionalSupport, policies });
    const decision = plan({ ...ON, memoryType: 'decision', text: SENTENCES.decisionMaking, policies });
    const reflection = plan({ ...ON, memoryType: 'goal', text: SENTENCES.personalReflection, policies });

    expect(technical.decision).toBe('WRITE');
    expect(emotional.decision).toBe('EPHEMERAL');
    expect(decision.decision).toBe('ASK_CONFIRM');
    expect(reflection.decision).toBe('EPHEMERAL');
  });
});
