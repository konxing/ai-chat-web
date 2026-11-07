import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { ApiClientError } from '@/lib/client-api';
import { upstreamReason } from '@/lib/ai';
import { firstNonHalfWidth, providerInputSchema } from '@/lib/providers';

/**
 * 现场故障：管理员在后台填 OpenRouter 模型 ID 时，中文输入法把半角冒号打成了全角 `：`，
 * `nvidia/nemotron-3.5-super-vl：free` 存进库后每次发消息都被上游 400 拒绝，
 * 而界面只显示「模型服务返回错误（HTTP 400）」，完全看不出是哪个字符的问题。
 */

const BASE = {
  name: 'nvd',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  capabilities: ['text'],
  enabled: true,
  isDefault: false
};

describe('模型 ID / Base URL 半角校验', () => {
  it('全角冒号的模型 ID 保存时被拒绝，并点名那个字符', () => {
    const result = providerInputSchema.safeParse({ ...BASE, modelId: 'nvidia/nemotron-3.5-super-vl：free' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('全角冒号的模型 ID 应当被拒绝');
    const message = result.error.issues.find((issue) => issue.path[0] === 'modelId')?.message ?? '';
    expect(message).toContain('模型 ID');
    expect(message).toContain('「：」');
  });

  it('正常的 vendor/model:free 写法放行', () => {
    expect(providerInputSchema.safeParse({ ...BASE, modelId: 'nvidia/nemotron-3.5-super-vl:free' }).success).toBe(true);
    expect(providerInputSchema.safeParse({ ...BASE, modelId: 'deepseek-chat' }).success).toBe(true);
  });

  it('Base URL 里的全角字符和空格同样被拒绝', () => {
    expect(providerInputSchema.safeParse({ ...BASE, baseUrl: 'https://openrouter.ai/api/ｖ1' }).success).toBe(false);
    expect(providerInputSchema.safeParse({ ...BASE, baseUrl: 'https://openrouter.ai/api /v1' }).success).toBe(false);
  });

  it('模型名称允许中文（只有地址和 ID 要求半角）', () => {
    expect(providerInputSchema.safeParse({ ...BASE, modelId: 'deepseek-chat', name: '深度求索' }).success).toBe(true);
  });

  it('已经存了坏 ID 的模型仍能被停用或删除：partial 校验只管提交上来的字段', () => {
    expect(providerInputSchema.partial().safeParse({ enabled: false }).success).toBe(true);
    expect(providerInputSchema.partial().safeParse({ modelId: 'nvidia/nemotron-3.5-super-vl：free' }).success).toBe(false);
  });

  it('firstNonHalfWidth 返回第一个越界字符', () => {
    expect(firstNonHalfWidth('abc:def')).toBeNull();
    expect(firstNonHalfWidth('a：b')).toBe('：');
    expect(firstNonHalfWidth('a b')).toBe(' ');
    expect(firstNonHalfWidth('模型')).toBe('模');
  });
});

describe('上游错误原因透传', () => {
  it('从 JSON 错误体里取 error.message', () => {
    const detail = '{"error":{"message":"nvidia/nemotron-3.5-super-vl：free is not a valid model ID","code":400}}';
    expect(upstreamReason(detail)).toBe('nvidia/nemotron-3.5-super-vl：free is not a valid model ID');
  });

  it('非 JSON 时取可打印片段，空体返回 null', () => {
    expect(upstreamReason('<html>Bad Request</html>')).toContain('Bad Request');
    expect(upstreamReason('   ')).toBeNull();
    expect(upstreamReason('模型服务暂时不可用')).toBeNull();
  });

  it('超长原因截断到 180 字符', () => {
    expect((upstreamReason(`{"error":{"message":"${'x'.repeat(500)}"}}`) ?? '').length).toBeLessThanOrEqual(180);
  });
});

describe('VALIDATION_ERROR 的字段原因显示', () => {
  it('details 里第一条字段消息成为用户看到的消息', () => {
    const err = new ApiClientError(400, {
      code: 'VALIDATION_ERROR',
      message: '请求参数无效',
      details: [{ path: 'modelId', message: '模型 ID 含非半角字符「：」，请只用英文半角字符（中文输入法常把 : 打成 ：）' }]
    });
    expect(err.message).toContain('模型 ID 含非半角字符');
  });

  it('其它错误码维持原消息，details 为空也不炸', () => {
    expect(new ApiClientError(500, { code: 'INTERNAL_ERROR', message: '服务器内部错误', details: [] }).message).toBe('服务器内部错误');
    expect(new ApiClientError(400, { code: 'VALIDATION_ERROR', message: '请求参数无效' }).message).toBe('请求参数无效');
  });
});
