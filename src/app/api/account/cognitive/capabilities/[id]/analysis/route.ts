import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { analyzeCapability, saveCapabilitySnapshot } from '@/lib/cognitive/capability-analysis';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { analysis: await analyzeCapability(user.id, (await ctx.params).id) };
  });
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { analysis: await saveCapabilitySnapshot(user.id, (await ctx.params).id) };
  });
}
