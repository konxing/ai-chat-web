import { z } from 'zod';
import { api, getRequestIp, readJson } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { createIpRule, listIpRules, writeAdminAudit } from '@/lib/admin';
import { ipRuleInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = ipRuleInputSchema.extend({
  confirmPassword: z.string().min(1).max(200)
});

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return { rules: await listIpRules(), currentIp: getRequestIp(req) };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = bodySchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    try {
      const rule = await createIpRule({
        cidr: body.cidr,
        label: body.label ?? body.cidr,
        enabled: body.enabled,
        expiresAt,
        createdById: user.id,
        actingIp: getRequestIp(req)
      });
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.create',
        targetType: 'ip_rule',
        targetId: rule.id,
        after: rule
      });
      return { rule };
    } catch (err) {
      await writeAdminAudit(req, user, {
        action: 'admin.ip_rule.create',
        targetType: 'ip_rule',
        after: { cidr: body.cidr, label: body.label ?? body.cidr },
        status: 'FAILURE',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  });
}
