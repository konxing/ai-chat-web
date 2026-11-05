-- 任务书 1.2 的 ASK_CONFIRM（「先问再记」）落地的第一半：问出来的那句话得有个地方待着。
--
-- 为什么不给 MemoryItem 加一列 status：没确认的话在**现有六条读路径**（对话注入、时间线、变化、
-- 记忆网络、洞察、画像）上都不得出现。加一列就得每条读路都记得过滤，漏一处的后果是
-- 「系统把自己的猜测当成用户说过的话带进提示词」。表分开，这类错误按结构不可能发生。
--
-- 状态只有三个（PENDING/CONFIRMED/REJECTED）：用户不理它就一直 PENDING，顶多被数量上限挤掉。
-- 没有「过期」「稍后再问」——那只是给同一个「不记」再发明几种说法。

-- CreateEnum
CREATE TYPE "MemoryCandidateStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "MemoryCandidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "sourceMessageId" TEXT,
    "type" "MemoryType" NOT NULL,
    "context" "MemoryContext" NOT NULL,
    -- 正文和 MemoryItem 同等对待：AES-256-GCM，AAD 绑这一行自己的 userId 和 id。
    "contentCiphertext" TEXT NOT NULL,
    -- 复用排除规则那一份 HMAC(APP_SECRET, userId:归一化正文)：
    -- 「这句问过了吗」和「这句被删过吗」必须是同一个「这句」的定义，两处各算就会漂。
    "contentHash" TEXT NOT NULL,
    "status" "MemoryCandidateStatus" NOT NULL DEFAULT 'PENDING',
    -- 提出时的时间说法，确认时原样带进 MemoryItem，不在这里二次解释。
    "validPrecision" "TimePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "validFrom" TIMESTAMP(3),
    -- PENDING 恒为 null：「没答」和「答了」用这一列分，不用时间猜。
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 列表屏的形状：按用户取待确认的那批，最近提出的排前面。
CREATE INDEX "MemoryCandidate_userId_status_createdAt_idx" ON "MemoryCandidate"("userId", "status", "createdAt");

-- CreateIndex
-- 同一句话只问一次：待确认期间不重复问，答过「不」的那句以后也不回来。
CREATE UNIQUE INDEX "MemoryCandidate_userId_contentHash_key" ON "MemoryCandidate"("userId", "contentHash");

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- 「忘记这次对话」把这一轮问出来的候选一起收走（门槛 2），外键级联先兜住；服务层仍显式删，
-- 因为「清空全部长期记忆」和「按主题忘记」不走 chat 级联。
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
