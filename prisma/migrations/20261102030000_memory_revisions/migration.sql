-- CreateEnum
CREATE TYPE "MemoryRevisionAction" AS ENUM ('SUPERSEDED', 'RETRACTED');

-- CreateTable
CREATE TABLE "MemoryRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "MemoryRevisionAction" NOT NULL,
    "memoryId" TEXT NOT NULL,
    "previousId" TEXT,
    "reasonCiphertext" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryRevision_memoryId_idx" ON "MemoryRevision"("memoryId");

-- CreateIndex
CREATE INDEX "MemoryRevision_previousId_idx" ON "MemoryRevision"("previousId");

-- CreateIndex
CREATE INDEX "MemoryRevision_userId_createdAt_idx" ON "MemoryRevision"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "MemoryRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "MemoryRevision_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "MemoryRevision_previousId_fkey" FOREIGN KEY ("previousId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

