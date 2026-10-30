import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { backupFilePath } from '@/lib/backups';
import { writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  file: z.string().min(1).max(128),
  confirmPassword: z.string().min(1).max(200)
});

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = bodySchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const full = await backupFilePath(body.file);
    await writeAdminAudit(req, user, {
      action: 'admin.backup.download',
      targetType: 'backup',
      targetId: body.file
    });
    const stream = Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${body.file}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  });
}
