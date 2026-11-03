-- AlterTable
-- 两列都可空：既有行一条都不动，没算过向量的记忆照常只用关键词召回。
ALTER TABLE "MemoryItem" ADD COLUMN     "embeddingCiphertext" BYTEA,
ADD COLUMN     "embeddingModel" TEXT;
