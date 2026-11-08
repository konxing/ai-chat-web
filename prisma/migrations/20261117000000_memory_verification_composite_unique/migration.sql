-- MemoryVerification is a one-to-one model with a compound FK (memoryId, userId).
-- Prisma 6 requires this precise defining-side tuple to have its own unique constraint.
-- Keep the existing single-column memoryId unique index and owner-scoped foreign key intact.
-- This is additive and safe for databases where the earlier migrations already ran.
CREATE UNIQUE INDEX "MemoryVerification_memoryId_userId_key"
  ON "MemoryVerification"("memoryId", "userId");
