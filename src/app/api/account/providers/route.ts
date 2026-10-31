import { prisma } from '@/lib/prisma';
import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import {
  createProvider,
  listProvidersForUser,
  listUserProviders,
  maskProvider,
  providerInputSchema,
  testProvider,
  updateProvider
} from '@/lib/providers';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return {
      mine: await listUserProviders(user.id),
      available: await listProvidersForUser(user.id)
    };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = providerInputSchema.parse(await readJson(req));
    const provider = await createProvider({ type: 'USER', userId: user.id }, body);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.ai_provider_create',
      targetType: 'ai_provider',
      targetId: provider.id,
      after: maskProvider(provider),
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { provider: maskProvider(provider) };
  });
}

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const payload = await readJson<{ id?: string } & Record<string, unknown>>(req);
    if (!payload.id) throw new ApiError(400, 'MISSING_ID', '缺少模型配置 ID');
    const existing = await prisma.aiProvider.findFirst({ where: { id: payload.id, ownerType: 'USER', userId: user.id } });
    if (!existing) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型配置不存在');
    const rest = { ...payload };
    delete rest.id;
    const parsed = providerInputSchema.partial().parse(rest);
    const provider = await updateProvider(existing, parsed);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.ai_provider_update',
      targetType: 'ai_provider',
      targetId: provider.id,
      before: maskProvider(existing),
      after: maskProvider(provider),
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { provider: maskProvider(provider) };
  });
}

export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) throw new ApiError(400, 'MISSING_ID', '缺少模型配置 ID');
    const existing = await prisma.aiProvider.findFirst({ where: { id, ownerType: 'USER', userId: user.id } });
    if (!existing) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型配置不存在');
    await prisma.aiProvider.delete({ where: { id } });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.ai_provider_delete',
      targetType: 'ai_provider',
      targetId: id,
      before: maskProvider(existing),
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { deleted: true };
  });
}

export async function PUT(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`provider-test:${user.id}`, 10, 10 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `测试过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const body = await readJson<{ id?: string }>(req);
    if (!body.id) throw new ApiError(400, 'MISSING_ID', '缺少模型配置 ID');
    const existing = await prisma.aiProvider.findFirst({ where: { id: body.id, ownerType: 'USER', userId: user.id } });
    if (!existing) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型配置不存在');
    const result = await testProvider(existing);
    return result;
  });
}
