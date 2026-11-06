-- 记忆关系表（任务书 2.3 / 3.1）。
-- 纯新增：不改任何既有表；两端用 (id, userId) 复合外键，跨用户边在库层插不进去。

-- CreateEnum
CREATE TYPE "MemoryRelationType" AS ENUM (
  'RELATED_TO',
  'SAME_TOPIC',
  'SUPPORTS',
  'CONTRADICTS',
  'EVOLVES_FROM',
  'PART_OF',
  'OCCURRED_BEFORE',
  'CAUSES_WITH_EVIDENCE'
);

-- CreateEnum
CREATE TYPE "MemoryRelationOrigin" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "MemoryRelationStatus" AS ENUM ('ACTIVE', 'REJECTED');

-- CreateTable
CREATE TABLE "MemoryRelation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceMemoryId" TEXT NOT NULL,
  "targetMemoryId" TEXT NOT NULL,
  "relationType" "MemoryRelationType" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "origin" "MemoryRelationOrigin" NOT NULL DEFAULT 'SYSTEM',
  "status" "MemoryRelationStatus" NOT NULL DEFAULT 'ACTIVE',
  "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRelation_userId_sourceMemoryId_targetMemoryId_relationType_key"
  ON "MemoryRelation"("userId", "sourceMemoryId", "targetMemoryId", "relationType");

-- CreateIndex
CREATE INDEX "MemoryRelation_userId_sourceMemoryId_status_idx"
  ON "MemoryRelation"("userId", "sourceMemoryId", "status");

-- CreateIndex
CREATE INDEX "MemoryRelation_userId_targetMemoryId_status_idx"
  ON "MemoryRelation"("userId", "targetMemoryId", "status");

-- AddForeignKey
ALTER TABLE "MemoryRelation"
  ADD CONSTRAINT "MemoryRelation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRelation"
  ADD CONSTRAINT "MemoryRelation_sourceMemoryId_userId_fkey"
  FOREIGN KEY ("sourceMemoryId", "userId") REFERENCES "MemoryItem"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRelation"
  ADD CONSTRAINT "MemoryRelation_targetMemoryId_userId_fkey"
  FOREIGN KEY ("targetMemoryId", "userId") REFERENCES "MemoryItem"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;