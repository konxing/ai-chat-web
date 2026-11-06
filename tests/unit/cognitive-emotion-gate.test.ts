import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMemoryCandidates } from '@/lib/cognitive/memory-extractor';
import { MEMORY_READ_MAX_ITEMS, selectMemoryCandidates } from '@/lib/cognitive/memory-module';
import { classifyContext } from '@/lib/cognitive/context-classifier';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import type { MemoryDto } from '@/lib/cognitive/memories';

/**
 * 片U：`emotionEnabled` 从「只有存储和校验声明的一列」变成「链路上的闸门」，并且只在有读者之后拿到控件。
 *
 * 动手前先量了三件事，结论都写在这里，因为它们是这片为什么长成这样的全部理由：
 * 一、这个开关今天**零运行时读者**（只有 `preferences.ts` 的存取、`validation.ts` 的校验、`manager.ts` 的映射表）。
 * 二、情绪类的记忆行**零生产者**：`memory-extractor.ts` 的规则表只有 decision / project / goal / preference / fact
 *     五种类型，头注释里明写「情绪句不在这里抽（那是情感引擎的活）」；而七个情境的默认
 *     `allowedMemoryTypes` 一个都没有包含 `emotion`（`policy.ts` 的 DEFAULT_MEMORY_POLICIES 与 sensitiveDefaults）。
 * 三、真库里今天 2 行记忆全是 GOAL、待确认候选 0 行，也就是情绪行一行都不存在。
 *
 * 所以只补闸门是不够的：闸门下面没有水源，控件摆出来还是一个骗人的旋钮。
 * 这一片补的是**整条链路**——生产者（只在开关打开时抽，抽的是用户原话整句）、两道闸门（写侧不生成、
 * 读侧不端出）、以及有读者之后才给的控件。开关默认 false，于是关掉时的行为与今天逐字节相同。
 *
 * 一条方向性红线单独钉（最后那个 describe）：**关掉只会更保守，不会更松**。
 * 情境分类里那套情绪词表不受这个开关影响——它的作用是把一句话引到最保守的策略上（不落长期库），
 * 把它跟着开关一起关掉，等于用户一关开关，私密倾诉就改按普通情境落库，那是隐私倒退。
 */

const OCCURRED = new Date('2026-11-02T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(OCCURRED.getTime() - days * DAY_MS).toISOString();
}

function row(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'mem-1',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'project',
    context: 'general',
    origin: 'explicit',
    content: '我在用 Prisma',
    confirmedAt: OCCURRED.toISOString(),
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: OCCURRED.toISOString(),
    ...overrides
  };
}

/** 一行情绪 + 三行别的：既看得出情绪行被不被丢掉，也看得出别的行不受牵连。 */
function pool() {
  return [
    row({ id: 'emo', type: 'emotion', content: '我这周天天失眠', recordedAt: isoDaysAgo(1) }),
    row({ id: 'prj', type: 'project', content: '我在用 Prisma 做数据库层', recordedAt: isoDaysAgo(2) }),
    row({ id: 'goal', type: 'goal', content: '我打算明年考研', recordedAt: isoDaysAgo(3) }),
    row({ id: 'fact', type: 'fact', content: '我住在上海', recordedAt: isoDaysAgo(4) })
  ];
}

function cognitiveSourceFiles(): string[] {
  return readdirSync(resolve(process.cwd(), 'src/lib/cognitive'))
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function sourceOf(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src/lib/cognitive', name), 'utf8');
}

function componentSource(relative: string): string {
  const raw = readFileSync(resolve(process.cwd(), relative), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const POLICY_PANEL = componentSource('src/components/settings/memory-policy-panel.tsx');

describe('生产者：情绪句只在开关打开时才抽', () => {
  it('不传开关时一条都不抽——这就是今天线上的形状', () => {
    expect(extractMemoryCandidates('我今天心里很烦。')).toEqual([]);
  });

  it('开关打开才抽，抽的是用户原话整句，类型是 emotion', () => {
    expect(extractMemoryCandidates('我今天心里很烦。', { emotionEnabled: true })).toEqual([
      { text: '我今天心里很烦', type: 'emotion' }
    ]);
  });

  it('问句不是陈述：「我今天心里很烦吗」一条都不抽', () => {
    expect(extractMemoryCandidates('我今天心里很烦吗？', { emotionEnabled: true })).toEqual([]);
  });

  it('不是第一人称就不抽：「她心里很难受」不是用户在说自己', () => {
    expect(extractMemoryCandidates('她心里很难受，一直哭。', { emotionEnabled: true })).toEqual([]);
  });

  it('一句话同时像偏好和情绪时先当情绪处理', () => {
    const sentence = '我不喜欢现在的自己，我心里难受。';
    expect(extractMemoryCandidates(sentence, { emotionEnabled: true })).toEqual([
      { text: '我不喜欢现在的自己，我心里难受', type: 'emotion' }
    ]);
    // 关掉时这句话仍按今天的类型落，闸门不改其它类型的行为。
    expect(extractMemoryCandidates(sentence)).toEqual([
      { text: '我不喜欢现在的自己，我心里难受', type: 'preference' }
    ]);
  });
});

describe('读侧闸门：emotionEnabled 关掉就不端情绪行', () => {
  const base = { chatId: 'chat-1', now: OCCURRED, policies: DEFAULT_MEMORY_POLICIES };

  it('false：情绪行不进排序、不占名额，也就进不了引用清单', () => {
    const picked = selectMemoryCandidates({ ...base, query: '失眠 项目', rows: pool(), emotionEnabled: false });

    expect(picked.map((memory) => memory.id)).not.toContain('emo');
    expect(picked.map((memory) => memory.id)).toEqual(expect.arrayContaining(['prj', 'goal', 'fact']));
  });

  it('没传这个字段时今天的形状逐字节不变——评测 Harness 和既有 fixture 走的就是这一条', () => {
    const picked = selectMemoryCandidates({ ...base, query: '失眠 项目', rows: pool() });

    expect(picked.map((memory) => memory.id)).toContain('emo');
  });

  it('true 时闸门不拦，但 emotionTransparency=off 仍然连候选池都不进（两把锁各自独立）', () => {
    const open = selectMemoryCandidates({ ...base, query: '失眠', rows: pool(), emotionEnabled: true });
    expect(open.map((memory) => memory.id)).toContain('emo');

    const silent = selectMemoryCandidates({
      ...base,
      query: '失眠',
      rows: pool(),
      emotionEnabled: true,
      emotionTransparency: 'off'
    });
    expect(silent.map((memory) => memory.id)).not.toContain('emo');
  });

  it('闸门丢的只有情绪行：其它类型一条都不少，名额也不为空出来的行让位', () => {
    const picked = selectMemoryCandidates({ ...base, query: '失眠 项目', rows: pool(), emotionEnabled: false });

    expect(picked).toHaveLength(3);
    expect(picked.length).toBeLessThanOrEqual(MEMORY_READ_MAX_ITEMS);
  });
});

describe('单一出处：这个开关真被运行时代码读', () => {
  it('除声明处（preferences / manager）之外，认知目录里真有文件按它做判断', () => {
    const declared = new Set(['preferences.ts', 'manager.ts']);
    const readers = cognitiveSourceFiles().filter(
      (name) => !declared.has(name) && sourceOf(name).includes('emotionEnabled')
    );

    expect(readers).toEqual(['memory-extractor.ts', 'memory-module.ts']);
  });
});

describe('界面：有读者之后才有控件', () => {
  it('策略面板摆出这个开关，读的是偏好接口里那一个值，写的也只那一个键', () => {
    expect(POLICY_PANEL).toContain('preferences.emotionEnabled');
    expect(POLICY_PANEL).toContain('checked={emotionModule === true}');
    expect(POLICY_PANEL).toContain('json: { emotionEnabled: next }');
  });

  it('控件把话说全：它是总闸，打开还要情境卡勾了「情绪」才真落库', () => {
    expect(POLICY_PANEL).toContain('使用情绪类记忆');
    expect(POLICY_PANEL).toContain('不再把你说的话抽成情绪类记忆');
    expect(POLICY_PANEL).toContain('还要上面每张情境卡里勾了「情绪」');
  });

  it('读不到状态时不替用户猜：那一档决定模型能不能看到情绪记录', () => {
    expect(POLICY_PANEL).toContain('disabled={emotionModule === null || emotionModuleBusy}');
    expect(POLICY_PANEL).toContain('开关状态没读到');
  });

  it('尾段那句「情绪总开关没有运行时消费者」必须消失——这一片之后它是假话', () => {
    expect(POLICY_PANEL).not.toContain('情绪总开关至今没有运行时消费者');
    expect(POLICY_PANEL).not.toContain('能用的情绪控件只有上面那三档标注');
  });
});

describe('方向性：关掉只会更保守，不会更松', () => {
  it('情境分类那套情绪词表一个字都不受这个开关影响', () => {
    expect(sourceOf('context-classifier.ts')).not.toContain('emotionEnabled');
    // 这一条现在是绿的，将来也不许变红：敏感情境的判定不跟着开关走，
    // 否则用户一关开关，私密倾诉就改按普通情境落库——那是隐私倒退，不是「模块关了」。
    expect(classifyContext('我心里难受，整夜睡不着').winner).toBe('emotionalSupport');
  });
});
