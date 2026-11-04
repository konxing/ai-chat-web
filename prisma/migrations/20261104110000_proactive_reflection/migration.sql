-- CreateEnum
CREATE TYPE "ReflectionType" AS ENUM ('PATTERN', 'GOAL_DRIFT', 'UNRESOLVED', 'INTEREST_SHIFT', 'CONTRADICTION', 'MILESTONE', 'DECISION_LESSON');

-- CreateEnum
CREATE TYPE "ReflectionCitationKind" AS ENUM ('SUPPORTS', 'CONTRADICTS');

-- CreateEnum
CREATE TYPE "ReflectionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EDITED', 'SNOOZED', 'EXPIRED');

-- AlterTable
ALTER TABLE "CognitivePreference" ADD COLUMN     "reflectionSweptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReflectionRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReflectionType" NOT NULL,
    "status" "ReflectionStatus" NOT NULL DEFAULT 'PENDING',
    "dedupKey" VARCHAR(80) NOT NULL,
    "titleCiphertext" TEXT NOT NULL,
    "bodyCiphertext" TEXT NOT NULL,
    "alternativesCiphertext" TEXT,
    "counterTokensCiphertext" TEXT NOT NULL,
    "counterHitCount" INTEGER NOT NULL,
    "timeFrom" TIMESTAMP(3),
    "timeTo" TIMESTAMP(3),
    "timePrecision" "TimePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "sampleCount" INTEGER NOT NULL,
    "observationSpanDays" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReflectionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReflectionCitation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reflectionId" TEXT NOT NULL,
    "memoryId" TEXT,
    "decisionId" TEXT,
    "kind" "ReflectionCitationKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReflectionCitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReflectionRecord_userId_status_idx" ON "ReflectionRecord"("userId", "status");

-- CreateIndex
CREATE INDEX "ReflectionRecord_userId_generatedAt_idx" ON "ReflectionRecord"("userId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionRecord_id_userId_key" ON "ReflectionRecord"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionRecord_userId_dedupKey_key" ON "ReflectionRecord"("userId", "dedupKey");

-- CreateIndex
CREATE INDEX "ReflectionCitation_userId_reflectionId_idx" ON "ReflectionCitation"("userId", "reflectionId");

-- CreateIndex
CREATE INDEX "ReflectionCitation_userId_memoryId_idx" ON "ReflectionCitation"("userId", "memoryId");

-- CreateIndex
CREATE INDEX "ReflectionCitation_userId_decisionId_idx" ON "ReflectionCitation"("userId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionCitation_reflectionId_memoryId_key" ON "ReflectionCitation"("reflectionId", "memoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionCitation_reflectionId_decisionId_key" ON "ReflectionCitation"("reflectionId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryItem_id_userId_key" ON "MemoryItem"("id", "userId");

-- AddForeignKey
ALTER TABLE "ReflectionRecord" ADD CONSTRAINT "ReflectionRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionCitation" ADD CONSTRAINT "ReflectionCitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionCitation" ADD CONSTRAINT "ReflectionCitation_reflectionId_userId_fkey" FOREIGN KEY ("reflectionId", "userId") REFERENCES "ReflectionRecord"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionCitation" ADD CONSTRAINT "ReflectionCitation_memoryId_userId_fkey" FOREIGN KEY ("memoryId", "userId") REFERENCES "MemoryItem"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionCitation" ADD CONSTRAINT "ReflectionCitation_decisionId_userId_fkey" FOREIGN KEY ("decisionId", "userId") REFERENCES "DecisionRecord"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

