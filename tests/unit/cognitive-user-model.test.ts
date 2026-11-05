import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_CANDIDATE_MEMORY_NOTE,
  PROFILE_CANDIDATE_REFLECTION_NOTE
} from '@/lib/cognitive/user-profile-display';
import { deriveProfileCandidates, type ProfileCandidateSource } from '@/lib/cognitive/profile-candidates';
import {
  USER_MODEL_MAX_CHARS,
  USER_MODEL_MAX_ITEMS,
  renderProfileBlock
} from '@/lib/cognitive/user-model-module';
import type { MemoryContext, MemoryPolicy } from '@/lib/cognitive/policy';

/**
 * 用户模型的候选派生与注入（任务书 8.2 / 8.3 的「画像」那一半）。
 *
 * 这一份文件要钉住的是三条互不相干的线，混一条就整个塌：
 *
 * 一、**候选是算出来的，不是存下来的。**派生只吃已经存在的行（记忆、洞察、画像条目），
 * 产出的东西没有任何路径能进 UserProfileEntry——所以这个文件里不许出现 prisma，测试直接断源码。
 * 二、**注入只带用户确认过的条目，候选一条都不进提示词。**画像模块的读侧只读那张表，
 * 它连候选长什么样都拿不到；这不是省事，是「系统推断不许凌驾于用户真实表达之上」在结构上的形态。
 * 三、**来源的情境关着门，派生品不许从旁边绕过去。**一条洞察引用了 3 条记忆，
 * 只要有一个情境把 allowUserProfile 关了，这条洞察就不成为画像候选。
 *
 * 洞察没有自己的 context 列（ReflectionRecord 上确实没有），所以第三条只能按引用行反查；
 * 一条引用都没有的洞察直接不提议——追溯不到来源的东西，摆出来就是让用户替系统确认一句没凭据的话。
 */

/** 七个情境的字面量，抄自 policy.ts:12-20 的 CONTEXT_PAIRS——这里只用它拼策略表，
 * 所以刻意用 import type 而不是把 policy 拖进运行时（那个模块顶层就 import prisma）。 */
const ALL_CONTEXTS = [
  'general',
  'technicalProject',
  'learning',
  'personalGoal',
  'personalReflection',
  'emotionalSupport',
  'decisionMaking'
] as const satisfies readonly MemoryContext[];

function policies(overrides: Partial<Record<MemoryContext, Partial<MemoryPolicy>>> = {}) {
  const table = {} as Record<MemoryContext, MemoryPolicy>;
  for (const context of ALL_CONTEXTS) {
    table[context] = {
      context,
      allowPersistence: true,
      allowedMemoryTypes: ['fact'],
      requireConfirmation: false,
      retention: 'forever',
      allowUserProfile: true,
      allowReflection: true,
      allowAssociation: false,
      ...overrides[context]
    };
  }
  return table;
}

function memory(overrides: Partial<ProfileCandidateSource> & { id: string }): ProfileCandidateSource {
  return {
    context: 'general',
    origin: 'explicit',
    content: '我在上海工作',
    ...overrides
  };
}

function derive(input: Partial<Parameters<typeof deriveProfileCandidates>[0]> = {}) {
  return deriveProfileCandidates({
    memories: [],
    reflections: [],
    policies: policies(),
    profiledMemoryIds: new Set<string>(),
    ...input
  });
}

describe('画像候选：从说过的话派生，不凭空造', () => {
  it('亲口说过的记忆成为候选，且带着可确认的措辞与来源', () => {
    const list = derive({ memories: [memory({ id: 'm1', content: '我下周去京都' })] });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('我下周去京都');
    expect(list[0].sourceMemoryIds).toEqual(['m1']);
    expect(list[0].note).toBe(PROFILE_CANDIDATE_MEMORY_NOTE);
    // 这句标注必须逐字出现：候选是用户的话，但「整理成画像」这个动作是系统提出的。
    expect(PROFILE_CANDIDATE_MEMORY_NOTE).toContain('你');
  });

  it('系统观察或推断来的记忆不成为候选——画像只能建立在用户真实表达之上', () => {
    for (const origin of ['observed', 'inferred', 'hypothesis', 'retracted'] as const) {
      expect(derive({ memories: [memory({ id: `m-${origin}`, origin })] })).toEqual([]);
    }
    expect(derive({ memories: [memory({ id: 'm2', origin: 'userConfirmed' })] })).toHaveLength(1);
  });

  it('情境把 allowUserProfile 关了，就一条也不提议', () => {
    const list = derive({
      memories: [memory({ id: 'm1', context: 'personalReflection' })],
      policies: policies({ personalReflection: { allowUserProfile: false } })
    });
    expect(list).toEqual([]);
  });

  it('已经收进画像的那条记忆不再回头问第二遍', () => {
    expect(derive({ memories: [memory({ id: 'm1' })], profiledMemoryIds: new Set(['m1']) })).toEqual([]);
  });

  it('采纳过的洞察成为候选，并逐字标上「系统推断，未经你确认」', () => {
    const list = derive({
      reflections: [{ id: 'r1', status: 'ACCEPTED', title: '你倾向把难的事往后推', citedContexts: ['learning'] }]
    });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('你倾向把难的事往后推');
    expect(list[0].sourceReflectionIds).toEqual(['r1']);
    expect(list[0].note).toBe(PROFILE_CANDIDATE_REFLECTION_NOTE);
    expect(PROFILE_CANDIDATE_REFLECTION_NOTE).toBe('系统推断，未经你确认');
  });

  it('还没被采纳的洞察一条都不提议', () => {
    for (const status of ['PENDING', 'REJECTED', 'SNOOZED', 'EXPIRED'] as const) {
      expect(
        derive({ reflections: [{ id: `r-${status}`, status, title: '推断', citedContexts: ['learning'] }] })
      ).toEqual([]);
    }
    expect(derive({ reflections: [{ id: 'r2', status: 'EDITED', title: '改过的推断', citedContexts: ['learning'] }] })).toHaveLength(1);
  });

  it('引用的记忆里有一个情境关了门，这条洞察就不提议', () => {
    const list = derive({
      reflections: [{ id: 'r1', status: 'ACCEPTED', title: '推断', citedContexts: ['learning', 'personalReflection'] }],
      policies: policies({ personalReflection: { allowUserProfile: false } })
    });
    expect(list).toEqual([]);
  });

  it('一条引用都没有的洞察不提议——追溯不到来源就没法让用户确认', () => {
    expect(derive({ reflections: [{ id: 'r1', status: 'ACCEPTED', title: '推断', citedContexts: [] }] })).toEqual([]);
  });

  it('候选的次序是「你先说过的」在前，系统推断的在后', () => {
    const list = derive({
      memories: [memory({ id: 'm1' })],
      reflections: [{ id: 'r1', status: 'ACCEPTED', title: '推断', citedContexts: ['learning'] }]
    });
    expect(list.map((candidate) => candidate.from)).toEqual(['memory', 'reflection']);
  });

  it('派生层不碰数据库：候选永远不落库，进表只能走确认那一次', () => {
    const body = readFileSync(resolve(process.cwd(), 'src/lib/cognitive/profile-candidates.ts'), 'utf8');
    // 只看编译后真正留下的 import。`import type` 会被擦掉，带不来任何写能力，
    // 而 MemoryOrigin / ReflectionStatus 又只能有一个定义处，所以它是允许的。
    const runtimeImports = body
      .split('\n')
      .filter((line) => /^import\b/.test(line) && !/^import type\b/.test(line))
      .map((line) => line.match(/from '([^']+)'/)?.[1]);
    // 白名单：只有那份不含数据库的展示常量。将来想 import 服务层（那是绕个弯也能写库）会在这里红。
    expect(runtimeImports).toEqual(['./user-profile-display']);
    // 纯函数：一句 await 都没有——「能不能进画像」由用户那一次点击决定，派生层连写库的语法都凑不齐。
    expect(body).not.toMatch(/\bawait\b/);
  });
});

describe('画像注入：只端你确认过的，预算是硬线', () => {
  const entry = (id: string, content: string) => ({
    id,
    content,
    sourceMemoryIds: [],
    sourceReflectionIds: [],
    confirmedAt: '2026-11-05T00:00:00.000Z',
    editedAt: null
  });

  it('空画像不给模型塞任何东西，包括一句「画像为空」', () => {
    expect(renderProfileBlock([])).toEqual([]);
  });

  it('带进来的条目正文逐字出现在 text 里', () => {
    const [block] = renderProfileBlock([entry('p1', '我在上海工作')]);
    expect(block.module).toBe('userModel');
    expect(block.label).toBe('用户画像');
    expect(block.text).toContain('我在上海工作');
    // 这段文字必须明说自己是数据不是指令，否则它就是提示词里的一条可注入指令。
    expect(block.text).toMatch(/不是指令/);
  });

  it('条数与字符都是硬线，截掉的不进 text', () => {
    const many = Array.from({ length: USER_MODEL_MAX_ITEMS + 2 }, (_, index) =>
      entry(`p${index}`, `第${index}条画像`)
    );
    const [block] = renderProfileBlock(many);
    expect(block.text.split('\n').length - 1).toBeLessThanOrEqual(USER_MODEL_MAX_ITEMS);
    const last = `第${USER_MODEL_MAX_ITEMS + 1}条画像`;
    expect(block.text).not.toContain(last);
  });

  it('字符预算同样硬：一条放不下就一条都不端，绝不截半句冒充原文', () => {
    const tooLong = entry('p1', '我'.repeat(USER_MODEL_MAX_CHARS + 100));
    expect(renderProfileBlock([tooLong])).toEqual([]);

    // 每条 120 字，表头吃掉一部分之后装不满 6 条——装不下的整条丢掉，留下的都是完整原句。
    const line = (index: number) => `第${index}号画像：${'哦'.repeat(120)}`;
    const [block] = renderProfileBlock(
      Array.from({ length: USER_MODEL_MAX_ITEMS }, (_, index) => entry(`p${index}`, line(index)))
    );
    const items = block.text.split('\n').slice(1);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(USER_MODEL_MAX_ITEMS);
    expect(block.text.length).toBeLessThanOrEqual(USER_MODEL_MAX_CHARS);
    for (const item of items) {
      // 活下来的必须是整条原句：出现半句就是在用户没说的话后面替他往下写。
      expect(Array.from({ length: USER_MODEL_MAX_ITEMS }, (_, index) => `- ${line(index)}`)).toContain(item);
    }
  });

  it('画像条目不填 memoryIds——它不是记忆 id，填了界面就会报出模型没读过的东西', () => {
    const [block] = renderProfileBlock([entry('p1', '我在上海工作')]);
    expect(block.memoryIds).toBeUndefined();
  });

  it('读侧只有 read，没有 write：系统不许自己写画像', async () => {
    const { userModelModule } = await import('@/lib/cognitive/user-model-module');
    expect(userModelModule.key).toBe('userModel');
    expect(userModelModule.write).toBeUndefined();
  });

  it('注册进认知引擎，userModelEnabled 这个开关从此有消费者', async () => {
    const body = readFileSync(resolve(process.cwd(), 'src/lib/cognitive/memory-module.ts'), 'utf8');
    expect(body).toMatch(/registerCognitiveModule\(userModelModule\)/);
  });
});
