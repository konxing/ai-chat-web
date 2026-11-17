import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-AI-WebChat': '1' });
  if (process.env.AI_WEBCHAT_WINDOWS_LOCAL === 'false') {
    try {
      const origin = new URL(process.env.APP_URL ?? '');
      if (origin.protocol === 'https:') headers.set('X-AI-WebChat-Browser-Origin', origin.origin);
    } catch {
      // A missing public URL should never alter the health result.
    }
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { ok: true, status: 'healthy', time: new Date().toISOString() },
      { headers }
    );
  } catch {
    return Response.json(
      { ok: false, status: 'degraded' },
      { status: 503, headers }
    );
  }
}
