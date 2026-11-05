-- CreateTable
-- 任务书 8.2「用户画像」：这张表里只存用户确认过的自我描述。
-- 「只存确认过的」靠三件事兜住，不是靠一句承诺：confirmedAt 不可空、迁移里不给它 DEFAULT、
-- 服务层的写入入参根本没有这个字段（确认时间由服务在落库那一刻盖章）。
-- 没确认的候选永远只在纯函数层现算，不落库——所以也不需要一个「候选状态」列。
CREATE TABLE "UserProfileEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "sourceMemoryIds" TEXT[],
    "sourceReflectionIds" TEXT[],
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfileEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 画像一屏永远按用户取最近若干条（按确认时间倒序），这一条就是那个形状。
CREATE INDEX "UserProfileEntry_userId_confirmedAt_idx" ON "UserProfileEntry"("userId", "confirmedAt");

-- AddForeignKey
-- 画像条目只随账号消亡：「清空全部长期记忆」不碰它——它是你亲手确认过的东西，不是派生记录。
-- 界面要清它得走那个明确的清空入口，不是走记忆的任何一条忘记路径。
ALTER TABLE "UserProfileEntry" ADD CONSTRAINT "UserProfileEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
