import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { writeAdminAudit } from '@/lib/admin';
import { listActiveLoginLocks, releaseLoginLocks } from '@/lib/login-lock-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deleteSchema = z.object({
  ip: z.string().trim().min(1).max(64).optional(),
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return { locks: await listActiveLoginLocks() };
  });
}

export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = deleteSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const released = await releaseLoginLocks(body.ip);
    await writeAdminAudit(req, user, {
      action: 'admin.login_lock.release',
      targetType: 'login_lock',
      targetId: body.ip ?? 'all',
      after: { ip: body.ip ?? null, released }
    });
    return { released };
  });
}
