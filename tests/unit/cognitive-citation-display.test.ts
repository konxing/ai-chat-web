import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 任务书 8.2 那两句：「聊天界面支持显示 AI 引用历史记忆的轻量提示」「用户可以点击查看原始记忆来源」。
 *
 * 措辞和行形状全部搬进这个纯模块，理由与 memory-display.ts 同一份：聊天气泡是客户端组件，
 * 而记忆的正文与置信度都在 import 了 prisma 的服务层里。边界由本文件最后那条静态断言钉住。
 *
 * 这里断言的是**句子本身**，不是「有个句子」——改这里就是改用户看到的字，要重新批准。
 */

import {
  CITATION_MISSING_LABEL,
  CITATION_NOTE,
  citationHint,
  citationRows
} from '@/lib/cognitive/citation-display';
import type { MemoryDto } from '@/lib/cognitive/memories';

const RECORDED = '2026-11-03T17:32:58.000Z';

function row(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'mem-1',
    chatId: 'chat-1',
    sourceMessageId: null,
    type: 'project',
    context: 'technicalProject',
    origin: 'explicit',
    content: '我在用 Prisma',
    confirmedAt: RECORDED,
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: RECORDED,
    ...overrides
  };
}

describe('citationHint', () => {
  it('一条都没带上时是空串——界面什么都不渲染，不摆一个没人消费的控制', () => {
    expect(citationHint(0)).toBe('');
  });

  it('说的就是真正进了这一轮提示词的条数', () => {
    expect(citationHint(3)).toBe('这一轮带上了 3 条长期记忆');
  });
});

describe('citationRows', () => {
  it('顺序照引用的 id，正文一行，日期、可信度、来源会话拼成一行说明', () => {
    const rows = citationRows({
      ids: ['m2', 'm1'],
      memories: [row({ id: 'm1', content: '我在用 Prisma' }), row({ id: 'm2', content: '我周末去跑步', chatId: null })],
      chats: { 'chat-1': '关于项目' },
      confidence: { m1: { band: 'medium' }, m2: { band: 'low' } }
    });

    // 顺序是引用顺序（进了提示词的那条在前），不是列表自己的顺序。
    expect(rows.map((item) => item.text)).toEqual(['我周末去跑步', '我在用 Prisma']);
    expect(rows[0]!.meta).toBe('记于 2026年11月3日 · 可信度低');
    expect(rows[1]!.meta).toBe('记于 2026年11月3日 · 可信度中 · 来自《关于项目》');
    expect(rows.map((item) => item.missing)).toEqual([false, false]);
  });

  it('引用的那条已经不在有效列表里：单独成一行说明，不静默丢掉', () => {
    const rows = citationRows({ ids: ['gone'], memories: [], chats: {}, confidence: {} });

    // 丢掉它等于让界面说「带上了 1 条」却点开列出 0 条——数字和清单必须对得上。
    expect(rows).toEqual([{ id: 'gone', text: CITATION_MISSING_LABEL, meta: '', missing: true }]);
  });

  it('算不出档位时按「可信度低」说，与提示词里那句标注同一口径', () => {
    const rows = citationRows({ ids: ['m1'], memories: [row({ id: 'm1' })], chats: {}, confidence: {} });

    expect(rows[0]!.meta).toContain('可信度低');
  });

  it('会话标题拿不到时不提来源，也不编一个', () => {
    const rows = citationRows({
      ids: ['m1'],
      memories: [row({ id: 'm1' })],
      chats: {},
      confidence: { m1: { band: 'high' } }
    });

    expect(rows[0]!.meta).toBe('记于 2026年11月3日 · 可信度高');
  });
});

describe('措辞逐字钉住', () => {
  it('展开区顶部那句说的是「带上了」，不是「模型依据它回答」', () => {
    expect(CITATION_NOTE).toBe('这只是这一轮随问题一起交给模型的资料，不代表模型按它回答了。');
    expect(CITATION_MISSING_LABEL).toBe('这条记忆已不在你的有效记忆里（可能已被更新或删除）');
  });
});

describe('纯模块边界', () => {
  it('运行时只许引用同样不碰服务端的那个展示模块——客户端组件才能安全引用', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/cognitive/citation-display.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('import') && !line.startsWith('import type'));

    // 日期与可信度的中文只许有这一份来源（6-G 那次统一的口径），所以允许引它；
    // 除它以外任何运行时引用都会把 prisma 拖进浏览器包。
    const specifiers = runtimeImports.map((line) => line.match(/from '([^']+)'/)?.[1] ?? line);
    expect(specifiers).toEqual(['./memory-display']);
  });
});
