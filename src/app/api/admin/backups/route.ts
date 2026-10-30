import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { createBackup, listBackups } from '@/lib/backups';
import { writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return { backups: await listBackups() };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = createSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    try {
      const meta = await createBackup();
      await writeAdminAudit(req, user, {
        action: 'admin.backup.create',
        targetType: 'backup',
        targetId: meta.file,
        after: { file: meta.file, bytes: meta.bytes, sha256: meta.sha256 }
      });
      return { backup: meta };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.backup.create',
        targetType: 'backup',
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}
