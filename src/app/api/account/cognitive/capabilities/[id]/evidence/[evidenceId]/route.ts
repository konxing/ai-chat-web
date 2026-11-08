import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { deleteEvidence } from '@/lib/cognitive/capabilities';
export const runtime = 'nodejs';
export async function DELETE(_req: Request, ctx: {
  params: Promise<{ id: string; evidenceId: string }>
}) {
  return api(async () => {
    const { user } = await requireUser(_req);
    const { id, evidenceId } = await ctx.params;
    return deleteEvidence(user.id, id, evidenceId);
  });
}
