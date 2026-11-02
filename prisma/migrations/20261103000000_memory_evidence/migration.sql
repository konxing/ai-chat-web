-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('SUPPORTS', 'CONTRADICTS');

-- CreateTable
CREATE TABLE "MemoryEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "origin" "MemoryOrigin" NOT NULL,
    "sourceMessageId" TEXT,
    "sourceChatId" TEXT,
    "noteCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEvidence_userId_memoryId_kind_sourceMessageId_key" ON "MemoryEvidence"("userId", "memoryId", "kind", "sourceMessageId");

-- CreateIndex
CREATE INDEX "MemoryEvidence_userId_memoryId_idx" ON "MemoryEvidence"("userId", "memoryId");

-- AddForeignKey
ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
