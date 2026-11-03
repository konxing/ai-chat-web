-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'AWAITING_REVIEW', 'OUTCOME_RECORDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DecisionCategory" AS ENUM ('TECH_CHOICE', 'PROJECT_PLANNING', 'CAREER', 'LEARNING', 'PURCHASE', 'PERSONAL_GOAL');

-- CreateEnum
CREATE TYPE "OutcomeLinkStatus" AS ENUM ('CANDIDATE', 'LINKED', 'DETACHED');

-- CreateTable
CREATE TABLE "DecisionRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "DecisionCategory" NOT NULL,
    "status" "DecisionStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
    "topicCiphertext" TEXT NOT NULL,
    "choiceCiphertext" TEXT NOT NULL,
    "backgroundCiphertext" TEXT,
    "constraintsCiphertext" TEXT,
    "optionsCiphertext" TEXT,
    "reasonCiphertext" TEXT,
    "criteriaCiphertext" TEXT,
    "expectedOutcomeCiphertext" TEXT,
    "risksCiphertext" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reviewAfter" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "sourceMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionOutcome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "linkStatus" "OutcomeLinkStatus" NOT NULL DEFAULT 'CANDIDATE',
    "actualCiphertext" TEXT NOT NULL,
    "gapCiphertext" TEXT,
    "ratingCiphertext" TEXT,
    "missedFactorsCiphertext" TEXT,
    "lessonCiphertext" TEXT,
    "sourceMessageId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionRecord_userId_status_idx" ON "DecisionRecord"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRecord_id_userId_key" ON "DecisionRecord"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRecord_sourceMessageId_category_key" ON "DecisionRecord"("sourceMessageId", "category");

-- CreateIndex
CREATE INDEX "DecisionOutcome_userId_decisionId_idx" ON "DecisionOutcome"("userId", "decisionId");

-- CreateIndex
CREATE INDEX "DecisionOutcome_userId_linkStatus_idx" ON "DecisionOutcome"("userId", "linkStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionOutcome_sourceMessageId_decisionId_key" ON "DecisionOutcome"("sourceMessageId", "decisionId");

-- AddForeignKey
ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_decisionId_userId_fkey" FOREIGN KEY ("decisionId", "userId") REFERENCES "DecisionRecord"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

