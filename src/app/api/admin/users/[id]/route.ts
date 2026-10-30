import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import {
  deleteManagedUser,
  resetManagedUserPassword,
  setUserEmail,
  setUserStatus,
  writeAdminAudit
} from '@/lib/admin';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('setStatus'),
    status: z.enum(['ACTIVE', 'DISABLED']),
    confirmPassword: z.string().min(1).max(200)
  }),
  z.object({
    action: z.literal('resetPassword'),
    confirmPassword: z.string().min(1).max(200)
  }),
  z.object({
    action: z.literal('setEmail'),
    email: z.string().trim().toLowerCase().email('邮箱格式无效').max(254),
    confirmPassword: z.string().min(1).max(200)
  })
]);

const deleteSchema = z.object({
  confirmPassword: z.string().min(1).max(200)
});

async function loadUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, email: true, role: true, status: true, displayName: true }
  });
  return user;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user: actor } = await requireOwner(req);
    const { id } = await ctx.params;
    const body = patchSchema.parse(await readJson(req));
    await requireOwnerPassword(actor.id, body.confirmPassword);
    const before = await loadUser(id);
    if (!before) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');

    try {
      if (body.action === 'setStatus') {
        const user = await setUserStatus(id, body.status, actor.id);
        await writeAdminAudit(req, actor, {
          action: 'admin.user.status',
          targetType: 'user',
          targetId: id,
          before: { status: before.status },
          after: { status: user.status }
        });
        return { user };
      }
      if (body.action === 'resetPassword') {
        const result = await resetManagedUserPassword(id);
        await writeAdminAudit(req, actor, {
          action: 'admin.user.reset_password',
          targetType: 'user',
          targetId: id,
          after: { username: before.username, sessionsRevoked: true }
        });
        return result;
      }
      const user = await setUserEmail(id, body.email);
      await writeAdminAudit(req, actor, {
        action: 'admin.user.email',
        targetType: 'user',
        targetId: id,
        before: { email: before.email },
        after: { email: user.email }
      });
      return { user };
    } catch (err) {
      await writeAdminAudit(req, actor, {
        action: `admin.user.${body.action}`,
        targetType: 'user',
        targetId: id,
        before,
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user: actor } = await requireOwner(req);
    const { id } = await ctx.params;
    const body = deleteSchema.parse(await readJson(req));
    await requireOwnerPassword(actor.id, body.confirmPassword);
    const before = await loadUser(id);
    if (!before) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
    try {
      await deleteManagedUser(id, actor.id);
      await writeAdminAudit(req, actor, {
        action: 'admin.user.delete',
        targetType: 'user',
        targetId: id,
        before
      });
      return { deleted: true };
    } catch (err) {
      await writeAdminAudit(req, actor, {
        action: 'admin.user.delete',
        targetType: 'user',
        targetId: id,
        before,
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}
