-- CreateTable
-- 任务书 7.1「记忆被再次调用时」：这一行记下的是「那一轮真把哪几条记忆带进了提示词」。
-- 列里只有 id，没有正文——照 CognitiveTask 的口径：没有可以放正文的列，比承诺不放正文难违反得多。
-- 一轮一行而不是一条记忆一行：注入上限 8 条，一轮记八列就得动 MemoryItem 那一行，
-- 而 assessConfidence 读的正是那一行（supersededAt、validTo）。
CREATE TABLE "MemoryAccessTurn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "memoryIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryAccessTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 幂等锚点在库层：一条消息重发不该记成两次访问，否则「被带到 3 次」里有一多半是重试。
CREATE UNIQUE INDEX "MemoryAccessTurn_sourceMessageId_key" ON "MemoryAccessTurn"("sourceMessageId");

-- CreateIndex
-- 读侧永远按用户取最近 200 轮，这一条就是那个形状。
CREATE INDEX "MemoryAccessTurn_userId_createdAt_idx" ON "MemoryAccessTurn"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemoryAccessTurn" ADD CONSTRAINT "MemoryAccessTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- 会话被真删掉时那句话没了，这一行跟着走。这张表上不留 chatId：
-- 「这一轮发生在哪次对话」本来就等于 sourceMessageId 那条消息所在的会话，多一列没有读者。
ALTER TABLE "MemoryAccessTurn" ADD CONSTRAINT "MemoryAccessTurn_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
