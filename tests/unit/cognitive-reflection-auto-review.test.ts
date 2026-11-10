import { afterEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  enabled: vi.fn()
}));
vi.mock('@/lib/prisma', () => ({ prisma: { reflectionRecord: db } }));
vi.mock('@/lib/crypto', () => ({ decryptString: (value: string) => value }));
vi.mock('@/lib/ai', () => ({
  async *streamChatCompletion() {
    yield { type: 'delta', text: '[{"id":"keep","action":"keep"},{"id":"drop","action":"drop"},{"id":"foreign","action":"keep"}]' };
  }
}));
vi.mock('@/lib/cognitive/memory-extractor-ai', () => ({
  AI_EXTRACTION_TIMEOUT_MS: 1000,
  resolveMemoryExtractionProvider: vi.fn()
}));
vi.mock('@/lib/cognitive/pending-confirmation-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cognitive/pending-confirmation-sweep')>()),
  autoConfirmEnabled: db.enabled
}));

afterEach(() => vi.useRealTimers());

it('reviews only eligible records for one account and fences each update against concurrent changes', async () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const updatedAt = new Date('2026-11-03T00:00:00Z');
  vi.useFakeTimers().setSystemTime(now);
  const { pollReflectionAutoReview } = await import('@/lib/cognitive/reflection-auto-review');
  db.enabled.mockResolvedValue(false);
  await pollReflectionAutoReview();
  expect(db.findFirst).not.toHaveBeenCalled();

  vi.advanceTimersByTime(60_000);
  db.enabled.mockResolvedValue(true);
  db.findFirst.mockResolvedValue({ userId: 'user-a' });
  db.findMany.mockResolvedValue(['keep', 'drop', 'omitted'].map((id) => ({
    id, updatedAt, titleCiphertext: 'title', bodyCiphertext: 'body'
  })));
  await pollReflectionAutoReview();

  const eligibility = {
    status: 'PENDING',
    generatedAt: { lte: new Date('2026-11-03T00:01:00Z') },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date('2026-11-10T00:01:00Z') } }],
    user: { status: 'ACTIVE', cognitive: { is: { memoryEnabled: true, reflectionEnabled: true } } }
  };
  expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ...eligibility, userId: 'user-a' } }));
  expect(db.updateMany).toHaveBeenCalledTimes(2);
  for (const [id, status] of [['keep', 'ACCEPTED'], ['drop', 'REJECTED']]) {
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { ...eligibility, id, userId: 'user-a', updatedAt },
      data: { status, decidedAt: new Date('2026-11-10T00:01:00Z'), reviewedByAi: true }
    });
  }
});
