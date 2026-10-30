import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { getSystemSettings, updateSystemSettings } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import { listGlobalProviders } from '@/lib/providers';
import { writeAdminAudit } from '@/lib/admin';
import { adminConfigSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = adminConfigSchema.extend({
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    const [settings, providers] = await Promise.all([getSystemSettings(), listGlobalProviders()]);
    return { settings, providers };
  });
}

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = patchSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const before = await getSystemSettings();
    if (body.defaultProviderId) {
      const provider = await prisma.aiProvider.findFirst({
        where: { id: body.defaultProviderId, ownerType: 'GLOBAL' }
      });
      if (!provider) throw new ApiError(400, 'PROVIDER_NOT_FOUND', '所选全局模型不存在');
    }
    const { confirmPassword: _confirmPassword, ...patch } = body;
    const settings = await updateSystemSettings(patch, user.id);
    await writeAdminAudit(req, user, {
      action: 'admin.config.update',
      targetType: 'system_config',
      before,
      after: settings
    });
    return { settings };
  });
}
