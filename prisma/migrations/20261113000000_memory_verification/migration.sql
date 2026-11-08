CREATE TABLE "MemoryVerification" (
  "id" TEXT NOT NULL,"userId" TEXT NOT NULL,"memoryId" TEXT NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED',
  "volatility" VARCHAR(12) NOT NULL DEFAULT 'MEDIUM',
  "checkedAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3),
  "reviewer" VARCHAR(24),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemoryVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemoryVerification_memoryId_key" ON "MemoryVerification"("memoryId");
CREATE INDEX "MemoryVerification_userId_status_expiresAt_idx" ON "MemoryVerification"("userId","status","expiresAt");
ALTER TABLE "MemoryVerification" ADD CONSTRAINT "MemoryVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryVerification" ADD CONSTRAINT "MemoryVerification_memoryId_userId_fkey" FOREIGN KEY ("memoryId","userId") REFERENCES "MemoryItem"("id","userId") ON DELETE CASCADE ON UPDATE CASCADE;
