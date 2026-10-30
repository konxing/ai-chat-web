import { prisma } from '@/lib/prisma';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { updateProfileSchema } from '@/lib/validation';
import { publicSettings, publicUser } from '@/lib/serializers';
import { writeAudit } from '@/lib/audit';
import { getRequestIp, getUserAgent } from '@/lib/http';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user, session } = await requireUser(req);
    const sessions = await prisma.session.count({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }
    });
    return {
      user: publicUser(user),
      currentSessionId: session.id,
      activeSessions: sessions,
      settings: await publicSettings()
    };
  });
}

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = updateProfileSchema.parse(await readJson(req));
    const displayName = body.displayName?.trim() ? body.displayName.trim() : null;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { displayName }
    });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.profile_update',
      targetType: 'user',
      targetId: user.id,
      before: { displayName: user.displayName },
      after: { displayName },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { user: publicUser(updated) };
  });
}
