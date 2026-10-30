import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { cleanupOrphanAttachments, storageBreakdown, writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actionSchema = z.object({
  action: z.literal('cleanupOrphans'),
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return storageBreakdown();
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = actionSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const result = await cleanupOrphanAttachments(user.id);
    await writeAdminAudit(req, user, {
      action: 'admin.storage.cleanup_orphans',
      targetType: 'storage',
      after: result
    });
    return result;
  });
}
