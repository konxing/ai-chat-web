-- CreateTable
CREATE TABLE "MemoryExclusion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "chatId" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryExclusion_userId_contentHash_key" ON "MemoryExclusion"("userId", "contentHash");

-- CreateIndex
CREATE INDEX "MemoryExclusion_userId_createdAt_idx" ON "MemoryExclusion"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemoryExclusion" ADD CONSTRAINT "MemoryExclusion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
