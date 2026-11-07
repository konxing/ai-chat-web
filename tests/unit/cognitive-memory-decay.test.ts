import { describe, expect, it } from 'vitest';
import { decayPriority } from '@/lib/cognitive/memory-decay';
import type { MemoryDto } from '@/lib/cognitive/memories';

/**
 * 记忆衰减（Phase 5）。钉红线：只改优先级不删历史、衰减≠可信度；新近度为主分量，
 * 确认与稳定类型加分；久未使用优先级下降但永不归零。
 */
const NOW = new Date('2026-11-07T00:00:00.000Z');

function row(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'm-1',
    chatId: null,
    sourceMessageId: null,
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    content: '我住在杭州',
    confirmedAt: null,
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-11-06T00:00:00.000Z',
    ...overrides
  } as MemoryDto;
}

describe('decayPriority', () => {
  it('越新优先级越高', () => {
    const recent = decayPriority(row({ recordedAt: '2026-11-06T00:00:00.000Z' }), NOW);
    const old = decayPriority(row({ recordedAt: '2026-08-01T00:00:00.000Z' }), NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it('久未使用优先级下降但永不归零（历史事实仍可召回）', () => {
    const ancient = decayPriority(row({ recordedAt: '2020-01-01T00:00:00.000Z' }), NOW);
    expect(ancient).toBeGreaterThan(0);
  });

  it('用户确认过的加分', () => {
    const confirmed = decayPriority(row({ confirmedAt: '2026-11-06T00:00:00.000Z' }), NOW);
    const unconfirmed = decayPriority(row({ confirmedAt: null }), NOW);
    expect(confirmed).toBeGreaterThan(unconfirmed);
  });

  it('事实/偏好这类稳定记忆比情景记忆衰减慢（同时间略高）', () => {
    const fact = decayPriority(row({ type: 'fact' }), NOW);
    const episodic = decayPriority(row({ type: 'project' }), NOW);
    expect(fact).toBeGreaterThan(episodic);
  });
});