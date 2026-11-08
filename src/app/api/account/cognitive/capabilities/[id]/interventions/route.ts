import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listInterventions } from '@/lib/cognitive/interventions';
export const runtime = 'nodejs';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { interventions: await listInterventions(user.id, (await ctx.params).id) };
  });
}
