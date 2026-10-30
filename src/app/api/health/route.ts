import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { ok: true, status: 'healthy', time: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return Response.json(
      { ok: false, status: 'degraded' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
