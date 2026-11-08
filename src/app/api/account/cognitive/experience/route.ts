import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { createExperience, listExperienceNotes } from '@/lib/cognitive/experience';
export const runtime = 'nodejs';
const input = z.object({
  memoryId: z.string().uuid().optional(),
  interventionId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  lesson: z.string().trim().min(1).max(2000),
  validation: z.string().trim().max(1200).nullable().optional()
}).strict();
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { experiences: await listExperienceNotes(user.id) };
  });
}
export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit('experience-create:' + user.id, 30, 3600000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '创建过于频繁');
    }
    return { experience: await createExperience(user.id, input.parse(await readJson(req))) };
  });
}
