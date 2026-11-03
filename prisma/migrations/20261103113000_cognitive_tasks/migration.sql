-- CreateEnum
CREATE TYPE "CognitiveTaskKind" AS ENUM ('MEMORY');

-- CreateEnum
CREATE TYPE "CognitiveTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'DEAD');

-- CreateTable
CREATE TABLE "CognitiveTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "kind" "CognitiveTaskKind" NOT NULL,
    "status" "CognitiveTaskStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(64),
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CognitiveTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CognitiveTask_sourceMessageId_kind_key" ON "CognitiveTask"("sourceMessageId", "kind");

-- CreateIndex
CREATE INDEX "CognitiveTask_status_availableAt_idx" ON "CognitiveTask"("status", "availableAt");

-- CreateIndex
CREATE INDEX "CognitiveTask_userId_chatId_idx" ON "CognitiveTask"("userId", "chatId");

-- AddForeignKey
ALTER TABLE "CognitiveTask" ADD CONSTRAINT "CognitiveTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CognitiveTask" ADD CONSTRAINT "CognitiveTask_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CognitiveTask" ADD CONSTRAINT "CognitiveTask_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
