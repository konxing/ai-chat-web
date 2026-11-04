-- AlterTable
-- 任务书 7.2 的 ARCHIVE。列可空：既有行一条都不动，没归档过的记忆默认就是「当前有效」。
-- 只加一列、不加索引：读侧永远先按 userId 筛，现有的 (userId, supersededAt) 前导列已经覆盖，
-- 而记忆列表本身有 200 行的硬上限。
ALTER TABLE "MemoryItem" ADD COLUMN     "archivedAt" TIMESTAMP(3);
