import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listMemories } from '@/lib/cognitive/memories';
import { filterVerifiedMemoryPool } from '@/lib/cognitive/memory-verification';
import { decryptString } from '@/lib/crypto';
import { cognitiveColumnAad } from '@/lib/cognitive/encrypted-columns';
export const runtime = 'nodejs';
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const memories = (await filterVerifiedMemoryPool(user.id, await listMemories(user.id, { take: 50 })))
      .map((m) => ({ id: m.id, title: m.content.slice(0, 110), type: 'MEMORY' }));
    const completed = await prisma.interventionRecord.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      take: 30, orderBy: { completedAt: 'desc' }
    });
    const interventions = completed.map((row) => ({
      id: row.id, type: 'INTERVENTION',
      title: decryptString(row.suggestionCiphertext,
        cognitiveColumnAad('InterventionRecord', 'suggestionCiphertext', user.id, row.id)).slice(0, 110)
    }));
    return { sources: [...memories, ...interventions] };
  });
}
