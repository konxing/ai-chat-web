CREATE TABLE "DreamingRun" (
"userId" TEXT NOT NULL,"nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"lastRunAt" TIMESTAMP(3),"leaseUntil" TIMESTAMP(3),"leaseToken" VARCHAR(64),
"checkedCount" INTEGER NOT NULL DEFAULT 0,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "DreamingRun_pkey" PRIMARY KEY ("userId"));
CREATE INDEX "DreamingRun_nextRunAt_leaseUntil_idx" ON "DreamingRun"("nextRunAt","leaseUntil");
ALTER TABLE "DreamingRun" ADD CONSTRAINT "DreamingRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
