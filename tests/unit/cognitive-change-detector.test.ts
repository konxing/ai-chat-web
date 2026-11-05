import { describe, expect, it } from 'vitest';
import { detectChanges } from '@/lib/cognitive/change-detector';
import type { MemoryDto } from '@/lib/cognitive/memories';
import type { TimelineEdge } from '@/lib/cognitive/timeline';

/**
 * 任务书 4.3 的 ChangeDetector。
 *
 * 4.3 要检测六件事：①兴趣出现和变化、②目标状态变化、③项目进展、④偏好变化、
 * ⑤长期重复主题、⑥长时间未解决的事项。这一层的形状是**观察**，不是结论：
 * 每条观察都必须带着样本数量、观察时间跨度和它自己的出处行，
 * 一个字的判断性措辞都不写（措辞在 `change-display.ts`，那里有封闭句式表）。
 *
 * ②③④ 走版本链：库里已经有演化边，而演化边是写侧（Phase 2C 改口接线）判过
 * 「这两句说的是同一件事」才留下的——这一层继承那个判断，不重做词法相似度。
 * 4-T3 量过：相似度在中文语料上 0/36，重做就是把已知的死路再走一遍。
 * ①⑤⑥ 走主题簇，用的是 6.1 同一把尺子（同一个分词、同一个 `TOPIC_MIN_OVERLAP`、
 * 同一组门槛常量），不另起一套标准。
 *
 * 这一片**不碰数据库、不碰 crypto、不调模型**。输入是调用方已经解密好的行，
 * 而且用的是界面那一套小写枚举（`preference` / `goal` / `retracted`），
 * 不是 6.1 那边从 prisma 整行读回来的大写枚举——`isActive` 那类比较必须跟着小写，
 * 抄错就是永远为真。
 *
 * 测试：src/lib/cognitive/change-detector.ts
 */

const NOW = new Date('2026-11-05T00:00:00.000Z');

interface RowSeed {
  id: string;
  type: MemoryDto['type'];
  content: string;
  chatId?: string | null;
  origin?: MemoryDto['origin'];
  supersededAt?: string | null;
  recordedAt?: string;
  validFrom?: string | null;
  precision?: MemoryDto['precision'];
}

function row(seed: RowSeed): MemoryDto {
  return {
    id: seed.id,
    chatId: seed.chatId === undefined ? 'chat-1' : seed.chatId,
    sourceMessageId: `msg-${seed.id}`,
    type: seed.type,
    context: 'general',
    origin: seed.origin ?? 'explicit',
    content: seed.content,
    confirmedAt: null,
    precision: seed.precision ?? 'unknown',
    validFrom: seed.validFrom ?? null,
    validTo: null,
    version: 1,
    supersededAt: seed.supersededAt ?? null,
    recordedAt: seed.recordedAt ?? '2026-10-01T00:00:00.000Z'
  };
}

function edge(
  memoryId: string,
  previousId: string | null,
  action: TimelineEdge['action'] = 'superseded',
  createdAt = '2026-10-20T00:00:00.000Z'
): TimelineEdge {
  return { memoryId, previousId, action, createdAt };
}

function changes(memories: MemoryDto[], edges: TimelineEdge[] = []) {
  return detectChanges({ now: NOW, memories, edges }).observations;
}

describe('④ 偏好变化（版本链）', () => {
  const pair = (): MemoryDto[] => [
    row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z' }),
    row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2', recordedAt: '2026-10-21T00:00:00.000Z' })
  ];

  it('同一件事的两版说法跨了两个会话，就是一条偏好变化', () => {
    const observations = changes(pair(), [edge('new', 'old')]);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.subject).toBe('PREFERENCE');
    expect(observations[0]?.change).toBe('CHANGED');
    // 前后分开给：界面要说清旧说法是哪一行、新说法是哪一行，而不是一团 id。
    expect(observations[0]?.beforeMemoryIds).toEqual(['old']);
    expect(observations[0]?.afterMemoryIds).toEqual(['new']);
  });

  it('样本数量和观察跨度跟着每一条观察走——4.3 点名要这两列', () => {
    const [change] = changes(pair(), [edge('new', 'old')]);

    expect(change?.sampleCount).toBe(2);
    // 2026-09-01 → 2026-10-21
    expect(change?.observationSpanDays).toBe(50);
    expect(change?.firstSeenAt).toBe('2026-09-01T00:00:00.000Z');
    expect(change?.lastSeenAt).toBe('2026-10-21T00:00:00.000Z');
  });

  it('两版说法出自同一个会话时不算变化，并且要说清差在哪条门槛', () => {
    const sameChat = pair().map((item) => ({ ...item, chatId: 'chat-1' }));
    const result = detectChanges({ now: NOW, memories: sameChat, edges: [edge('new', 'old')] });

    // 同一个会话里改两次口是一次讨论，不是偏好变了（和 6.1 PATTERN 同一套理由）。
    expect(result.observations).toEqual([]);
    expect(result.insufficient).toEqual([
      expect.objectContaining({ subject: 'PREFERENCE', reason: 'BELOW_CHAT_MIN', sampleCount: 2 })
    ]);
  });

  it('两边都读不到会话时按证据不足处理，不靠猜把它算成跨会话', () => {
    const noChat = pair().map((item) => ({ ...item, chatId: null }));
    const result = detectChanges({ now: NOW, memories: noChat, edges: [edge('new', 'old')] });

    expect(result.observations).toEqual([]);
    expect(result.insufficient[0]?.reason).toBe('BELOW_CHAT_MIN');
  });
});

describe('② 目标状态变化（版本链）', () => {
  it('目标换了说法是 CHANGED', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'goal', content: '我打算今年跑完全马', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.subject).toBe('GOAL');
    expect(observations[0]?.change).toBe('CHANGED');
  });

  it('新那一版里出现完成说法就是 COMPLETED，不是 CHANGED', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'goal', content: '我完成了半马', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.change).toBe('COMPLETED');
  });

  it('完成说法只看新那一版：旧说法里带过不算到达', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'goal', content: '我完成了半马训练计划的一半', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'goal', content: '我打算把半马跑完', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.change).toBe('CHANGED');
  });

  it('RETRACTED 那条边是 WITHDRAWN，前驱缺失也照样成立', () => {
    const observations = changes([row({ id: 'gone', type: 'goal', content: '我打算今年跑完半马' })], [edge('gone', null, 'retracted')]);

    expect(observations[0]?.subject).toBe('GOAL');
    expect(observations[0]?.change).toBe('WITHDRAWN');
    // 撤回只有一句话，没有「后」的那一版：这句话放在变化前，之后什么都没有。
    // 先写用例时我把 id 放到了 after 那边，那等于让界面把「现在」指向一行已经不成立的说法。
    expect(observations[0]?.beforeMemoryIds).toEqual(['gone']);
    expect(observations[0]?.afterMemoryIds).toEqual([]);
  });
});

describe('③ 项目进展（版本链）', () => {
  it('项目多了一版说法就是 UPDATED', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'project', content: '我在做家庭聊天记录这个项目', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'project', content: '我在做家庭聊天记录这个项目，已经接上数据库', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.subject).toBe('PROJECT');
    expect(observations[0]?.change).toBe('UPDATED');
  });

  it('项目不借用完成说法：③ 要的是进展，到达归 ② 那套', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'project', content: '我在做家庭聊天记录这个项目', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'project', content: '我把家庭聊天记录这个项目上线了', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.change).toBe('UPDATED');
  });
});

describe('版本链的边界：不许新增事实', () => {
  it('演化边指向这一批里没有的行时跳过该边，不编出半个出处', () => {
    const result = detectChanges({
      now: NOW,
      memories: [row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2' })],
      edges: [edge('new', 'missing')]
    });

    expect(result.observations).toEqual([]);
    // 也不许落进 insufficient：那条结构是回答「差在哪条门槛」的，读不到的行不是门槛问题。
    expect(result.insufficient).toEqual([]);
  });

  it('fact / decision / emotion 的演化不产出观察——4.3 的六件事里没有它们', () => {
    const result = detectChanges({
      now: NOW,
      memories: [
        row({ id: 'f-old', type: 'fact', content: '我在上海工作', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'f-new', type: 'fact', content: '我在杭州工作', chatId: 'chat-2' }),
        row({ id: 'd-old', type: 'decision', content: '我决定选甲方案', chatId: 'chat-3', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'd-new', type: 'decision', content: '我决定选乙方案', chatId: 'chat-4' }),
        row({ id: 'e-old', type: 'emotion', content: '我最近很焦虑', chatId: 'chat-5', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'e-new', type: 'emotion', content: '我最近还好', chatId: 'chat-6' })
      ],
      edges: [edge('f-new', 'f-old'), edge('d-new', 'd-old'), edge('e-new', 'e-old')]
    });

    expect(result.observations).toEqual([]);
    expect(result.insufficient).toEqual([]);
  });

  it('没有演化边时一条也不产出：孤行是经历，不是变化', () => {
    const result = detectChanges({ now: NOW, memories: [row({ id: 'solo', type: 'goal', content: '我打算今年跑完半马' })], edges: [] });

    expect(result.observations).toEqual([]);
    // 这一批在 ⑥ 那边只是「放得还不够久」，不是链侧漏了什么——链侧一条 insufficient 也不该有。
    expect(result.insufficient).toEqual([
      expect.objectContaining({ subject: 'UNRESOLVED', reason: 'BELOW_AGE_MIN', sampleCount: 1 })
    ]);
  });

  it('三版连成的链产出两条观察，前后接得上', () => {
    const observations = changes(
      [
        row({ id: 'v1', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-05T00:00:00.000Z', recordedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 'v2', type: 'preference', content: '我习惯下午写代码', chatId: 'chat-2', supersededAt: '2026-10-20T00:00:00.000Z', recordedAt: '2026-10-05T00:00:00.000Z' }),
        row({ id: 'v3', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-3', recordedAt: '2026-10-20T00:00:00.000Z' })
      ],
      [edge('v2', 'v1'), edge('v3', 'v2')]
    );

    expect(observations).toHaveLength(2);
    expect(observations.map((change) => [change.beforeMemoryIds, change.afterMemoryIds])).toEqual([
      [['v1'], ['v2']],
      [['v2'], ['v3']]
    ]);
  });

  it('链侧的时刻是改口的记录时刻，所以精度一律 TIMESTAMP，不跟着 validFrom 走', () => {
    const observations = changes(
      [
        { ...row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }), precision: 'year', validFrom: '2025-01-01T00:00:00.000Z' },
        row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.timePrecision).toBe('TIMESTAMP');
  });

  it('确认状态来自 origin：两句里有一句是用户说过或确认过的，就算确认过', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2', origin: 'userConfirmed' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.confirmed).toBe(true);
  });

  it('两句都是观察或推测出来的时不算确认过', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', origin: 'hypothesis', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2', origin: 'observed' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.confirmed).toBe(false);
  });

  it('主题词取自新那一版：断言的是哪一版供的词，不是分词器的切法', () => {
    const observations = changes(
      [
        row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2' })
      ],
      [edge('new', 'old')]
    );

    expect(observations[0]?.topicTokens).toContain('早上');
    expect(observations[0]?.topicTokens).not.toContain('晚上');
  });

  it('空输入得到空结果', () => {
    expect(detectChanges({ now: NOW, memories: [], edges: [] })).toEqual({ observations: [], insufficient: [] });
  });

  it('输出按时刻从早到晚排', () => {
    const observations = changes(
      [
        row({ id: 'a-old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-09-10T00:00:00.000Z', recordedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 'a-new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2', recordedAt: '2026-09-10T00:00:00.000Z' }),
        row({ id: 'b-old', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-3', supersededAt: '2026-07-10T00:00:00.000Z', recordedAt: '2026-06-01T00:00:00.000Z' }),
        row({ id: 'b-new', type: 'goal', content: '我打算今年跑完全马', chatId: 'chat-4', recordedAt: '2026-07-10T00:00:00.000Z' })
      ],
      [edge('a-new', 'a-old'), edge('b-new', 'b-old')]
    );

    // 先写用例时我以为这批只产出两条（链侧那两条）。追完规则发现当前那版目标已经放了 118 天、
    // 同主题这阵子一句都没有——⑥ 报一条 STILL_OPEN 是对的，是我的用例漏算了它。
    expect(observations.map((change) => change.subject)).toEqual(['GOAL', 'UNRESOLVED', 'PREFERENCE']);
    expect(observations.map((change) => change.firstSeenAt)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-07-10T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    ]);
  });
});

describe('⑤ 长期重复主题（主题簇）', () => {
  const recurring = (): MemoryDto[] => [
    row({ id: 'r1', type: 'preference', content: '我每周跑步这件事', chatId: 'chat-1', recordedAt: '2026-08-01T00:00:00.000Z' }),
    row({ id: 'r2', type: 'preference', content: '我坚持跑步这件事', chatId: 'chat-2', recordedAt: '2026-08-20T00:00:00.000Z' }),
    row({ id: 'r3', type: 'preference', content: '我喜欢跑步这件事', chatId: 'chat-3', recordedAt: '2026-09-15T00:00:00.000Z' })
  ];

  it('跨会话跨时间的同一主题是一条 RECURRING，样本数和跨度按簇给', () => {
    const observations = changes(recurring());
    const repetition = observations.find((change) => change.subject === 'REPETITION');

    expect(repetition?.change).toBe('RECURRING');
    expect(repetition?.sampleCount).toBe(3);
    expect(repetition?.observationSpanDays).toBe(45);
    expect(repetition?.afterMemoryIds).toEqual(['r1', 'r2', 'r3']);
    expect(repetition?.topicTokens).toContain('跑步');
  });

  it('被取代的旧说法进「变化前」那一侧，不冒充当前还在重复', () => {
    const observations = changes([
      ...recurring(),
      row({ id: 'r0', type: 'preference', content: '我以前讨厌跑步这件事', chatId: 'chat-0', supersededAt: '2026-08-01T00:00:00.000Z', recordedAt: '2026-07-01T00:00:00.000Z' })
    ]);
    const repetition = observations.find((change) => change.subject === 'REPETITION');

    expect(repetition?.beforeMemoryIds).toEqual(['r0']);
    expect(repetition?.afterMemoryIds).toEqual(['r1', 'r2', 'r3']);
    expect(repetition?.sampleCount).toBe(3);
  });

  it('三条说法都在同一个会话里时是证据不足，原因要说清', () => {
    const result = detectChanges({
      now: NOW,
      memories: recurring().map((item) => ({ ...item, chatId: 'chat-1' })),
      edges: []
    });

    expect(result.observations.some((change) => change.subject === 'REPETITION')).toBe(false);
    expect(result.insufficient).toContainEqual(
      expect.objectContaining({ subject: 'REPETITION', reason: 'BELOW_CHAT_MIN', sampleCount: 3 })
    );
  });

  it('两条就够不上重复：门槛用的是 6.1 那个常量，不是这里另写一个数', () => {
    const result = detectChanges({
      now: NOW,
      memories: [
        row({ id: 'r1', type: 'preference', content: '我每周跑步这件事', chatId: 'chat-1', recordedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 'r2', type: 'preference', content: '我坚持跑步这件事', chatId: 'chat-2', recordedAt: '2026-09-15T00:00:00.000Z' })
      ],
      edges: []
    });

    expect(result.observations.some((change) => change.subject === 'REPETITION')).toBe(false);
    expect(result.insufficient).toContainEqual(expect.objectContaining({ subject: 'REPETITION', reason: 'BELOW_SAMPLE_MIN', sampleCount: 2 }));
  });
});

describe('① 兴趣出现和变化（主题簇）', () => {
  const emerged = (): MemoryDto[] => [
    row({ id: 'n1', type: 'preference', content: '我想学唱歌这件事', chatId: 'chat-1', recordedAt: '2026-10-20T00:00:00.000Z' }),
    row({ id: 'n2', type: 'goal', content: '我在练唱歌这件事', chatId: 'chat-2', recordedAt: '2026-10-26T00:00:00.000Z' }),
    row({ id: 'n3', type: 'preference', content: '我爱上唱歌这件事', chatId: 'chat-3', recordedAt: '2026-11-01T00:00:00.000Z' })
  ];

  it('最近才出现、已经跨会话重复的主题是一条 EMERGED', () => {
    const observations = changes(emerged());
    const interest = observations.find((change) => change.subject === 'INTEREST');

    expect(interest?.change).toBe('EMERGED');
    expect(interest?.sampleCount).toBe(3);
    expect(interest?.beforeMemoryIds).toEqual([]);
    // 跨度不到 ⑤ 的门槛，但「出现」不需要跨一个月——这正是两类分开的原因。
    expect(interest?.observationSpanDays).toBe(12);
  });

  it('同一批行在 ⑤ 那边是证据不足，在 ① 这边照样成立', () => {
    const result = detectChanges({ now: NOW, memories: emerged(), edges: [] });

    expect(result.observations.some((change) => change.subject === 'REPETITION')).toBe(false);
    expect(result.insufficient).toContainEqual(expect.objectContaining({ subject: 'REPETITION', reason: 'BELOW_SPAN_MIN' }));
    expect(result.observations.some((change) => change.change === 'EMERGED')).toBe(true);
  });

  it('很久以前就在说的主题不算新出现：EMERGED 有自己的时间窗', () => {
    const observations = changes([
      row({ id: 'n1', type: 'preference', content: '我每周跑步这件事', chatId: 'chat-1', recordedAt: '2026-01-10T00:00:00.000Z' }),
      row({ id: 'n2', type: 'preference', content: '我坚持跑步这件事', chatId: 'chat-2', recordedAt: '2026-02-10T00:00:00.000Z' }),
      row({ id: 'n3', type: 'preference', content: '我喜欢跑步这件事', chatId: 'chat-3', recordedAt: '2026-03-10T00:00:00.000Z' })
    ]);

    expect(observations.some((change) => change.change === 'EMERGED')).toBe(false);
  });

  it('兴趣只由「偏好＋目标」两类行代表：一条 fact 簇不会产出 INTEREST', () => {
    const observations = changes([
      row({ id: 'f1', type: 'fact', content: '我上周开始跑步这件事', chatId: 'chat-1', recordedAt: '2026-10-06T00:00:00.000Z' }),
      row({ id: 'f2', type: 'fact', content: '我这周继续跑步这件事', chatId: 'chat-2', recordedAt: '2026-10-16T00:00:00.000Z' }),
      row({ id: 'f3', type: 'fact', content: '我还在跑步这件事', chatId: 'chat-3', recordedAt: '2026-10-26T00:00:00.000Z' })
    ]);

    expect(observations.some((change) => change.subject === 'INTEREST')).toBe(false);
    // 同一批行作为「长期重复主题」仍然成立——它们只是不代表兴趣。
    expect(observations.some((change) => change.subject === 'REPETITION')).toBe(true);
  });

  it('旧主题淡出、新主题近期内成簇，是 SHIFTED：前后两个簇的 id 都留下', () => {
    const observations = changes([
      row({ id: 'o1', type: 'preference', content: '我每周晨间跑步', chatId: 'chat-1', recordedAt: '2026-05-01T00:00:00.000Z' }),
      row({ id: 'o2', type: 'preference', content: '我坚持晨间跑步', chatId: 'chat-2', recordedAt: '2026-05-20T00:00:00.000Z' }),
      row({ id: 'o3', type: 'preference', content: '我喜欢晨间跑步', chatId: 'chat-3', recordedAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'n1', type: 'preference', content: '我想学晚间唱歌', chatId: 'chat-4', recordedAt: '2026-10-20T00:00:00.000Z' }),
      row({ id: 'n2', type: 'goal', content: '我在练晚间唱歌', chatId: 'chat-5', recordedAt: '2026-10-26T00:00:00.000Z' }),
      row({ id: 'n3', type: 'preference', content: '我爱上晚间唱歌', chatId: 'chat-6', recordedAt: '2026-11-01T00:00:00.000Z' })
    ]);
    const shift = observations.filter((change) => change.change === 'SHIFTED');

    expect(shift).toHaveLength(1);
    expect(shift[0]?.subject).toBe('INTEREST');
    expect(shift[0]?.beforeMemoryIds).toEqual(['o1', 'o2', 'o3']);
    expect(shift[0]?.afterMemoryIds).toEqual(['n1', 'n2', 'n3']);
    expect(shift[0]?.sampleCount).toBe(6);
  });

  it('一个主题进了 SHIFTED 就不再重复报 EMERGED：同一次移动只说一遍', () => {
    const observations = changes([
      row({ id: 'o1', type: 'preference', content: '我每周晨间跑步', chatId: 'chat-1', recordedAt: '2026-05-01T00:00:00.000Z' }),
      row({ id: 'o2', type: 'preference', content: '我坚持晨间跑步', chatId: 'chat-2', recordedAt: '2026-05-20T00:00:00.000Z' }),
      row({ id: 'o3', type: 'preference', content: '我喜欢晨间跑步', chatId: 'chat-3', recordedAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'n1', type: 'preference', content: '我想学晚间唱歌', chatId: 'chat-4', recordedAt: '2026-10-20T00:00:00.000Z' }),
      row({ id: 'n2', type: 'goal', content: '我在练晚间唱歌', chatId: 'chat-5', recordedAt: '2026-10-26T00:00:00.000Z' }),
      row({ id: 'n3', type: 'preference', content: '我爱上晚间唱歌', chatId: 'chat-6', recordedAt: '2026-11-01T00:00:00.000Z' })
    ]);

    expect(observations.filter((change) => change.change === 'EMERGED')).toHaveLength(0);
  });

  it('最近主题样本不够时不许把旧主题说成「被替换」，并记下差在哪', () => {
    const result = detectChanges({
      now: NOW,
      memories: [
        row({ id: 'o1', type: 'preference', content: '我每周晨间跑步', chatId: 'chat-1', recordedAt: '2026-05-01T00:00:00.000Z' }),
        row({ id: 'o2', type: 'preference', content: '我坚持晨间跑步', chatId: 'chat-2', recordedAt: '2026-05-20T00:00:00.000Z' }),
        row({ id: 'o3', type: 'preference', content: '我喜欢晨间跑步', chatId: 'chat-3', recordedAt: '2026-06-10T00:00:00.000Z' }),
        row({ id: 'n1', type: 'preference', content: '我想学晚间唱歌', chatId: 'chat-4', recordedAt: '2026-10-20T00:00:00.000Z' })
      ],
      edges: []
    });

    expect(result.observations.some((change) => change.change === 'SHIFTED')).toBe(false);
    expect(result.insufficient).toContainEqual(expect.objectContaining({ subject: 'INTEREST', reason: 'BELOW_SAMPLE_MIN' }));
  });
});

describe('⑥ 长时间未解决的事项（主题簇）', () => {
  it('目标放了很久、这阵子同主题一句都没有，是 STILL_OPEN', () => {
    const observations = changes([
      row({ id: 'g1', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', recordedAt: '2026-06-01T00:00:00.000Z' })
    ]);
    const open = observations.find((change) => change.subject === 'UNRESOLVED');

    expect(open?.change).toBe('STILL_OPEN');
    expect(open?.afterMemoryIds).toEqual(['g1']);
    expect(open?.sampleCount).toBe(1);
    expect(open?.observationSpanDays).toBe(157);
    // 时间窗的终点是「现在」这个系统时刻，不是某条记忆里的日期。
    expect(open?.lastSeenAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('目标自己的 validFrom 带着精度时，起点跟着那个精度走——不许把「今年」摊成某一天', () => {
    const observations = changes([
      row({
        id: 'g1',
        type: 'goal',
        content: '我打算今年跑完半马',
        chatId: 'chat-1',
        recordedAt: '2026-06-01T00:00:00.000Z',
        validFrom: '2026-01-01T00:00:00.000Z',
        precision: 'year'
      })
    ]);
    const open = observations.find((change) => change.subject === 'UNRESOLVED');

    expect(open?.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(open?.timePrecision).toBe('YEAR');
  });

  it('刚放下来的目标不到时间门槛：STILL_OPEN 不许在 60 天内出现，并且要说清差在哪', () => {
    const result = detectChanges({
      now: NOW,
      memories: [row({ id: 'g1', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', recordedAt: '2026-10-20T00:00:00.000Z' })],
      edges: []
    });

    expect(result.observations.some((change) => change.subject === 'UNRESOLVED')).toBe(false);
    expect(result.insufficient).toContainEqual(expect.objectContaining({ subject: 'UNRESOLVED', reason: 'BELOW_AGE_MIN' }));
  });

  it('这阵子还在说同一件事就不算没下文', () => {
    const observations = changes([
      row({ id: 'g1', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', recordedAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'g2', type: 'goal', content: '我还是打算跑完半马', chatId: 'chat-2', recordedAt: '2026-10-25T00:00:00.000Z' })
    ]);

    expect(observations.some((change) => change.subject === 'UNRESOLVED')).toBe(false);
  });

  it('被取代的目标不再算没下文：它已经有下文了', () => {
    const observations = changes([row({ id: 'g1', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', recordedAt: '2026-06-01T00:00:00.000Z', supersededAt: '2026-08-01T00:00:00.000Z' })]);

    expect(observations.some((change) => change.subject === 'UNRESOLVED')).toBe(false);
  });

  it('撤回掉的目标也不算没下文：那是用户自己收回去的', () => {
    const observations = changes([row({ id: 'g1', type: 'goal', content: '我打算今年跑完半马', chatId: 'chat-1', origin: 'retracted', recordedAt: '2026-06-01T00:00:00.000Z' })]);

    expect(observations.some((change) => change.subject === 'UNRESOLVED')).toBe(false);
  });
});

describe('六类共用的一条底线：不许把观察写成结论', () => {
  it('返回值里没有任何正文：只有 id、计数、时刻和主题词', () => {
    const report = detectChanges({
      now: NOW,
      memories: [
        row({ id: 'old', type: 'preference', content: '我习惯晚上写代码', chatId: 'chat-1', supersededAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'new', type: 'preference', content: '我习惯早上写代码', chatId: 'chat-2' })
      ],
      edges: [edge('new', 'old')]
    });
    const serialized = JSON.stringify(report);

    // 正文要留给措辞层按行取，观察结构里带上它就等于把一个可以被整包写日志的东西做好了。
    expect(serialized).not.toContain('我习惯晚上写代码');
    expect(serialized).not.toContain('我习惯早上写代码');
    expect(report.observations[0]).not.toHaveProperty('content');
    expect(report.observations[0]).not.toHaveProperty('text');
  });

  it('证据不足那一条结构里不许带主题词——它和 6.1 的 insufficient 一样要能进日志', () => {
    const result = detectChanges({
      now: NOW,
      memories: [
        row({ id: 'r1', type: 'preference', content: '我每周跑步这件事', chatId: 'chat-1', recordedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 'r2', type: 'preference', content: '我坚持跑步这件事', chatId: 'chat-1', recordedAt: '2026-08-20T00:00:00.000Z' })
      ],
      edges: []
    });

    expect(result.insufficient.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.insufficient)).not.toContain('跑步');
  });
});
