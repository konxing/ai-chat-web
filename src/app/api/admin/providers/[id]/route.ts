import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { maskProvider, providerInputSchema, updateProvider } from '@/lib/providers';
import { prisma } from '@/lib/prisma';
import { writeAdminAudit } from '@/lib/admin';
import { updateSystemSettings } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = providerInputSchema.partial().extend({
  confirmPassword: z.string().min(1).max(200)
});

const deleteSchema = z.object({
  confirmPassword: z.string().min(1).max(200)
});

async function loadGlobalProvider(id: string) {
  const provider = await prisma.aiProvider.findFirst({ where: { id, ownerType: 'GLOBAL' } });
  if (!provider) throw new ApiError(404, 'PROVIDER_NOT_FOUND', '全局模型不存在');
  return provider;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const { id } = await ctx.params;
    const body = patchSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const provider = await loadGlobalProvider(id);
    const { confirmPassword: _confirmPassword, ...input } = body;
    try {
      const updated = await updateProvider(provider, input);
      await writeAdminAudit(req, user, {
        action: 'admin.provider.update',
        targetType: 'ai_provider',
        targetId: id,
        before: maskProvider(provider),
        after: maskProvider(updated)
      });
      return { provider: maskProvider(updated) };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.provider.update',
        targetType: 'ai_provider',
        targetId: id,
        before: maskProvider(provider),
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const { id } = await ctx.params;
    const body = deleteSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const provider = await loadGlobalProvider(id);
    await prisma.aiProvider.delete({ where: { id } });
    const config = await prisma.systemConfig.findUnique({ where: { key: 'defaultProviderId' } });
    if (typeof config?.value === 'string' && config.value === id) {
      await updateSystemSettings({ defaultProviderId: null }, user.id);
    }
    await writeAdminAudit(req, user, {
      action: 'admin.provider.delete',
      targetType: 'ai_provider',
      targetId: id,
      before: maskProvider(provider)
    });
    return { deleted: true };
  });
}
