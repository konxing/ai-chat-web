import { api, getUserAgent, getRequestIp, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { memoryPolicyPatchSchema, memoryPolicyResetSchema } from '@/lib/validation';
import {
  getMemoryPolicies,
  getMemoryPolicy,
  resetMemoryPolicy,
  updateMemoryPolicy,
  type MemoryContext,
  type MemoryPolicy
} from '@/lib/cognitive/policy';

export const runtime = 'nodejs';

/**
 * 七种情境的记忆策略（任务书 1.2、1.3）。userId 只取自 session，情境只取自查询串或请求体，
 * 所以一个账号既读不到也改不了别人的策略行。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { policies: await getMemoryPolicies(user.id) };
  });
}

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = memoryPolicyPatchSchema.parse(await readJson(req));
    const policy = await auditChange(req, user.id, user.username, 'user.memory_policy_update', body.context, () =>
      updateMemoryPolicy(user.id, body.context, body.patch)
    );
    return { policy };
  });
}

export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { context } = memoryPolicyResetSchema.parse({ context: new URL(req.url).searchParams.get('context') });
    const policy = await auditChange(req, user.id, user.username, 'user.memory_policy_reset', context, () =>
      resetMemoryPolicy(user.id, context)
    );
    return { policy };
  });
}

/** 策略改动都要可追溯；审计里只有一个情境的布尔和枚举，不含任何对话内容。值没变就不写。 */
async function auditChange(
  req: Request,
  userId: string,
  username: string,
  action: string,
  context: MemoryContext,
  mutate: () => Promise<MemoryPolicy>
): Promise<MemoryPolicy> {
  const before = await getMemoryPolicy(userId, context);
  const policy = await mutate();
  if (JSON.stringify(before) !== JSON.stringify(policy)) {
    await writeAudit({
      actorId: userId,
      actorLabel: username,
      action,
      targetType: 'user',
      targetId: userId,
      before,
      after: policy,
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
  }
  return policy;
}
