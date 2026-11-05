import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, UNEMITTED_EVENT_KINDS } from '@/lib/cognitive/event-extractor';
import {
  EVENT_KIND_LABELS,
  FILTERABLE_EVENT_KINDS,
  UNEMITTED_EVENT_KIND_NOTE,
  describeEventKind
} from '@/lib/cognitive/event-display';

/**
 * 任务书 4.1 那 12 类的展示词汇。
 *
 * 和 `change-display.ts` 同一个来由：词汇表独立成一个纯函数模块，
 * 因为 `event-extractor.ts` 那一条链上挂着 `reflection-planner` 和 prisma 的枚举，
 * 客户端组件只要拿几个标签，直接引用就会把数据库驱动拖进浏览器包。
 * 所以这里全部走 `import type`，运行时一个字都不留。
 *
 * 两类要盯住的事：
 * 一、词汇表要盖住 12 类，包括这一层不生成的那 3 类——它们仍然要能被说出来，
 *    因为界面得能回答「为什么这一屏只有 9 类」。
 * 二、标签不许长成结论。任务书在 4.3 明令不许根据少数记录生成确定性人格结论，
 *    这条红线同样适用于事件类别的名字：名字只说「哪一类事」，不说「你是什么人」。
 *
 * 测试：src/lib/cognitive/event-display.ts
 */

describe('12 类都有标签', () => {
  it('标签表逐字盖住检测层那 12 类，一个不多一个不少', () => {
    expect(Object.keys(EVENT_KIND_LABELS).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it('不生成的那 3 类照样有名字：界面要能说出少了哪 3 类', () => {
    for (const kind of UNEMITTED_EVENT_KINDS) expect(EVENT_KIND_LABELS[kind].length).toBeGreaterThan(0);
  });

  it('能筛的那 9 类正好是 12 类减掉不生成的 3 类，顺序照检测层', () => {
    expect([...FILTERABLE_EVENT_KINDS]).toEqual(EVENT_KINDS.filter((kind) => !UNEMITTED_EVENT_KINDS.includes(kind)));
  });

  it('describeEventKind 就是把那张表读出来，不在措辞层再编一个说法', () => {
    expect(describeEventKind('GOAL_COMPLETED')).toBe(EVENT_KIND_LABELS.GOAL_COMPLETED);
    expect(describeEventKind('EXPERIENCE')).toBe(EVENT_KIND_LABELS.EXPERIENCE);
  });
});

describe('名字只说类别，不说人', () => {
  it('13 个不许出现的词，一个都不在任何标签里（任务书 4.3 的人格结论红线）', () => {
    const forbidden = [
      '你以后',
      '将来',
      '一定会',
      '注定',
      '性格',
      '人格',
      '本质',
      '说明你是',
      '证明你是',
      '意味着你',
      '典型',
      '人生态度',
      '价值观'
    ];
    const all = [...Object.values(EVENT_KIND_LABELS), UNEMITTED_EVENT_KIND_NOTE].join('｜');
    for (const word of forbidden) expect(all).not.toContain(word);
  });

  it('那句「少了三类」要说清少了哪三类、为什么，而不是一句「暂不支持」', () => {
    expect(UNEMITTED_EVENT_KIND_NOTE).toContain('12 类');
    expect(UNEMITTED_EVENT_KIND_NOTE).toContain('9 类');
    for (const kind of UNEMITTED_EVENT_KINDS) expect(UNEMITTED_EVENT_KIND_NOTE).toContain(EVENT_KIND_LABELS[kind]);
  });
});
