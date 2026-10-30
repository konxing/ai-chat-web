import { prisma } from '@/lib/prisma';
import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { revokeAllSessions } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user, session } = await requireUser(req);
    const rows = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50
    });
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === session.id
      }))
    };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user, session } = await requireUser(req);
    const revoked = await revokeAllSessions(user.id, session.id);
    return { revoked };
  });
}
