import { z } from 'zod';
import { api, getRequestIp, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { deleteIpRule, updateIpRule, writeAdminAudit } from '@/lib/admin';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  cidr: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().max(128).optional().nullable(),
  enabled: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  confirmPassword: z.string().min(1).max(200)
});

const deleteSchema = z.object({
  confirmPassword: z.string().min(1).max(200)
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const { id } = await ctx.params;
    const body = patchSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const before = await prisma.ipRule.findUnique({ where: { id } });
    if (!before) return { rule: null };
    try {
      const rule = await updateIpRule({
        id,
        cidr: body.cidr,
        label: body.label ?? undefined,
        enabled: body.enabled,
        expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt ? new Date(body.expiresAt) : null,
        actingIp: getRequestIp(req)
      });
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.update',
        targetType: 'ip_rule',
        targetId: id,
        before: {
          cidr: before.cidr,
          label: before.label,
          enabled: before.enabled,
          expiresAt: before.expiresAt
        },
        after: rule
      });
      return { rule };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.update',
        targetType: 'ip_rule',
        targetId: id,
        before: {
          cidr: before.cidr,
          label: before.label,
          enabled: before.enabled,
          expiresAt: before.expiresAt
        },
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
    const before = await prisma.ipRule.findUnique({ where: { id } });
    if (!before) return { deleted: true };
    try {
      await deleteIpRule({ id, actingIp: getRequestIp(req) });
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.delete',
        targetType: 'ip_rule',
        targetId: id,
        before: {
          cidr: before.cidr,
          label: before.label,
          enabled: before.enabled,
          expiresAt: before.expiresAt
        }
      });
      return { deleted: true };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.delete',
        targetType: 'ip_rule',
        targetId: id,
        before: {
          cidr: before.cidr,
          label: before.label,
          enabled: before.enabled,
          expiresAt: before.expiresAt
        },
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}
