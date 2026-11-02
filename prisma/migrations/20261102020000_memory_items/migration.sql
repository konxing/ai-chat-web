-- CreateEnum
CREATE TYPE "MemoryOrigin" AS ENUM ('EXPLICIT', 'USER_CONFIRMED', 'OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RETRACTED');

-- CreateEnum
CREATE TYPE "TimePrecision" AS ENUM ('UNKNOWN', 'YEAR', 'MONTH', 'DAY', 'TIMESTAMP');

-- CreateTable
CREATE TABLE "MemoryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "sourceMessageId" TEXT,
    "type" "MemoryType" NOT NULL,
    "context" "MemoryContext" NOT NULL,
    "origin" "MemoryOrigin" NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "validPrecision" "TimePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryItem_userId_supersededAt_idx" ON "MemoryItem"("userId", "supersededAt");

-- CreateIndex
CREATE INDEX "MemoryItem_userId_type_idx" ON "MemoryItem"("userId", "type");

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

