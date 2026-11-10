import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/files/[id]/route';

/**
 * GET /api/files/[id] 是全应用单次代价最大的一读：命中 ETag 只查一行，没命中就要把
 * 整个文件从磁盘读回来再解密（文档单文件上限 300MB）。这个入口此前只有 requireUser
 * 和一道 ETag，没有任何计数限流——登录之后就能把「读盘 + 解密」无限量地叠在进程里。
 *
 * `@/lib/rate-limit` 在这里是 mock 的：桶本身归 rate-limit-validation.test.ts 管，
 * 这里只钉路由自己那两层——闸开在哪一步、口径是什么。
 *
 * 第二条用例是这片的重点，不是 429 本身：`attachmentCalls` 必须为空，才证明闸在
 * `getAttachmentForUser` **之前**。写在之后的限流照样返回 429，但磁盘和数据库的活
 * 已经干完了，对要防的那件事一点用都没有。
 *
 * 600 而不是照抄上传的 120：一页历史是 60 条消息（`src/lib/chats.ts:167`）、每条最多
 * 15 个附件，图片是 `loading="lazy"`（`src/components/chat/markdown.tsx:70`）——快速划过
 * 一段照片密集的历史，一分钟里一两百次请求是正常用法。而这个入口的 429 落在 `<img src>`
 * 上就只是一张坏图，用户看不到任何消息。次数上限在这里管的是失控的循环，不是人的浏览。
 *
 * 也正因为它是**计数**上限：它封顶的是请求次数与随之而来的查行次数，不是字节数。
 * 每分钟 600 次 × 300MB 的文档依然能把进程压垮——那需要的是流式/体积闸，本片没有做。
 */
const ctx = vi.hoisted(() => ({
  limiterOk: true,
  limiterCalls: [] as Array<{ key: string; limit: number; windowMs: number }>,
  attachmentCalls: [] as string[],
  readCalls: 0
}));

vi.mock('@/lib/auth', () => ({
  requireUser: () => Promise.resolve({ user: { id: 'user-1', username: 'konxing' }, session: { id: 'sess-1' } })
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (key: string, limit: number, windowMs: number) => {
    ctx.limiterCalls.push({ key, limit, windowMs });
    return { ok: ctx.limiterOk, remaining: 0, retryAfterSec: 30, limit };
  }
}));

vi.mock('@/lib/files', () => ({
  getAttachmentForUser: (id: string) => {
    ctx.attachmentCalls.push(id);
    return Promise.resolve({ id, sha256: 'a'.repeat(64), kind: 'IMAGE', mime: 'image/png', messageId: null });
  },
  readAttachmentBuffer: () => {
    ctx.readCalls++;
    return Promise.resolve(Buffer.from('fake-png-bytes'));
  },
  attachmentName: () => 'photo.png',
  deleteAttachmentAndFile: () => Promise.resolve()
}));

const PARAMS = { params: Promise.resolve({ id: 'att-1' }) };

function request(ifNoneMatch?: string): Request {
  const headers: Record<string, string> = {};
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  return new Request('http://127.0.0.1:3000/api/files/att-1', { headers });
}

beforeEach(() => {
  ctx.limiterOk = true;
  ctx.limiterCalls = [];
  ctx.attachmentCalls = [];
  ctx.readCalls = 0;
});

describe('GET /api/files/[id] 的限流', () => {
  it('放行的下载按用户记账，口径是每分钟 600 次', async () => {
    const response = await GET(request(), PARAMS);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    // 逐个字段断言：`toEqual` 的失败信息会被 vitest 折成 `{ key: …, …(2) }`，
    // 数字错了也看不出是哪个错了。
    expect(ctx.limiterCalls).toHaveLength(1);
    expect(ctx.limiterCalls[0]?.key).toBe('download:user-1');
    expect(ctx.limiterCalls[0]?.limit).toBe(600);
    expect(ctx.limiterCalls[0]?.windowMs).toBe(60_000);
  });

  it('限流命中时返回 429，且一次附件读都没有发起', async () => {
    ctx.limiterOk = false;
    const response = await GET(request(), PARAMS);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(ctx.attachmentCalls).toEqual([]);
    expect(ctx.readCalls).toBe(0);
  });

  it('命中 ETag 的 304 同样记账，不是免费的重验证', async () => {
    const response = await GET(request(`"${'a'.repeat(64)}"`), PARAMS);
    expect(response.status).toBe(304);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(ctx.limiterCalls).toHaveLength(1);
    expect(ctx.readCalls).toBe(0);
  });
});
