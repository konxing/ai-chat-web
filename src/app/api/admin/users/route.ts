import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { createManagedUser, listUsers, writeAdminAudit } from '@/lib/admin';
import { emailSchema, usernameSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createUserSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  displayName: z.string().trim().max(64).optional().nullable(),
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return listUsers(new URL(req.url));
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = createUserSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    let result;
    try {
      result = await createManagedUser({
        username: body.username,
        email: body.email,
        displayName: body.displayName
      });
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.user.create',
        targetType: 'user',
        after: { username: body.username, email: body.email },
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
    await writeAdminAudit(req, user, {
      action: 'admin.user.create',
      targetType: 'user',
      targetId: result.user.id,
      after: { username: result.user.username, email: result.user.email }
    });
    return result;
  });
}
