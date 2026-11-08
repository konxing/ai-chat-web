import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { createDimension, listDimensions } from '@/lib/cognitive/capabilities';

export const runtime = 'nodejs';
const input = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().max(1000).nullable().optional()
}).strict();
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { dimensions: await listDimensions(user.id) };
  });
}
export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit('capability-create:' + user.id, 20, 3600000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '操作过于频繁');
    }
    const body = input.parse(await readJson(req));
    return { dimension: await createDimension(user.id, body) };
  });
}
