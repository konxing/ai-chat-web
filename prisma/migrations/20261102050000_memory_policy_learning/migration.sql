-- AlterTable
ALTER TABLE "MemoryPolicy" ADD COLUMN     "learnedAt" TIMESTAMP(3),
ADD COLUMN     "manualOverrideAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MemoryPolicySignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "context" "MemoryContext" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryPolicySignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryPolicySignal_userId_context_createdAt_idx" ON "MemoryPolicySignal"("userId", "context", "createdAt");

-- AddForeignKey
ALTER TABLE "MemoryPolicySignal" ADD CONSTRAINT "MemoryPolicySignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
