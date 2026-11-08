import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { parseAutoConfirmVerdicts } from '@/lib/cognitive/pending-confirmation-sweep';
import { profileCandidateKey } from '@/lib/cognitive/profile-dismissed';

/**
 * 待确认条目的超时自动裁决，纯逻辑两块：
 * - 模型裁决只认清单里的 id、只认 keep/drop、重复以第一次为准；
 * - 画像建议的稳定键（memory 优先、reflection 其次、最后退回内容）。
 */

const IDS = new Set(['mem:1', 'dec:2', 'prof:memory:m-1']);

describe('parseAutoConfirmVerdicts：防御性解析', () => {
  it('合法裁决逐条收下', () => {
    const got = parseAutoConfirmVerdicts(
      '[{"id":"mem:1","action":"keep"},{"id":"dec:2","action":"drop"}]',
      IDS
    );
    expect(got?.get('mem:1')).toBe('keep');
    expect(got?.get('dec:2')).toBe('drop');
  });

  it('清单外的 id、非法 action 一律丢弃', () => {
    const got = parseAutoConfirmVerdicts(
      '[{"id":"mem:999","action":"keep"},{"id":"mem:1","action":"delete"},{"id":"dec:2","action":"DROP"}]',
      IDS
    );
    expect(got?.size).toBe(0);
  });

  it('同一个 id 出现多次以第一次为准', () => {
    const got = parseAutoConfirmVerdicts(
      '[{"id":"mem:1","action":"keep"},{"id":"mem:1","action":"drop"}]',
      IDS
    );
    expect(got?.get('mem:1')).toBe('keep');
  });

  it('解析不出数组返回 null（调用方什么都不改）', () => {
    expect(parseAutoConfirmVerdicts('抱歉无法判断', IDS)).toBeNull();
    expect(parseAutoConfirmVerdicts('[broken', IDS)).toBeNull();
    expect(parseAutoConfirmVerdicts('{"id":"mem:1","action":"keep"}', IDS)).toBeNull();
  });

  it('空数组是合法结论（模型什么都没判）', () => {
    expect(parseAutoConfirmVerdicts('[]', IDS)?.size).toBe(0);
  });
});

describe('profileCandidateKey：稳定键', () => {
  it('优先来源记忆，其次来源洞察，最后退回内容前缀', () => {
    expect(
      profileCandidateKey({ content: 'x', sourceMemoryIds: ['m-1', 'm-2'], sourceReflectionIds: ['r-1'] })
    ).toBe('memory:m-1');
    expect(profileCandidateKey({ content: 'x', sourceMemoryIds: [], sourceReflectionIds: ['r-1'] })).toBe(
      'reflection:r-1'
    );
    expect(profileCandidateKey({ content: '没有来源的一句话', sourceMemoryIds: [], sourceReflectionIds: [] })).toBe(
      'text:没有来源的一句话'
    );
  });
});
