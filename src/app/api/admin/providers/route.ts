import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { createProvider, listGlobalProviders, maskProvider, providerInputSchema } from '@/lib/providers';
import { writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = providerInputSchema.extend({
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return { providers: await listGlobalProviders() };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = bodySchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const { confirmPassword: _confirmPassword, ...input } = body;
    try {
      const provider = await createProvider({ type: 'GLOBAL' }, input);
      await writeAdminAudit(req, user, {
        action: 'admin.provider.create',
        targetType: 'ai_provider',
        targetId: provider.id,
        after: maskProvider(provider)
      });
      return { provider: maskProvider(provider) };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.provider.create',
        targetType: 'ai_provider',
        after: { name: input.name, baseUrl: input.baseUrl, modelId: input.modelId },
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}
