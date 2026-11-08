CREATE UNIQUE INDEX "InterventionRecord_id_userId_key" ON "InterventionRecord"("id","userId");
CREATE TABLE "ExperienceNote" (
"id" TEXT NOT NULL,"userId" TEXT NOT NULL,
"sourceMemoryId" TEXT,"sourceInterventionId" TEXT,
"titleCiphertext" TEXT NOT NULL,"lessonCiphertext" TEXT NOT NULL,
"validationCiphertext" TEXT,"status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
"version" INTEGER NOT NULL DEFAULT 1,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "ExperienceNote_pkey" PRIMARY KEY ("id"),
CONSTRAINT "ExperienceNote_one_source_check" CHECK (
("sourceMemoryId" IS NOT NULL AND "sourceInterventionId" IS NULL) OR
("sourceMemoryId" IS NULL AND "sourceInterventionId" IS NOT NULL)
));
CREATE INDEX "ExperienceNote_userId_status_updatedAt_idx" ON "ExperienceNote"("userId","status","updatedAt");
CREATE INDEX "ExperienceNote_userId_sourceMemoryId_idx" ON "ExperienceNote"("userId","sourceMemoryId");
CREATE INDEX "ExperienceNote_userId_sourceInterventionId_idx" ON "ExperienceNote"("userId","sourceInterventionId");
ALTER TABLE "ExperienceNote" ADD CONSTRAINT "ExperienceNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExperienceNote" ADD CONSTRAINT "ExperienceNote_sourceMemoryId_userId_fkey" FOREIGN KEY ("sourceMemoryId","userId") REFERENCES "MemoryItem"("id","userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExperienceNote" ADD CONSTRAINT "ExperienceNote_sourceInterventionId_userId_fkey" FOREIGN KEY ("sourceInterventionId","userId") REFERENCES "InterventionRecord"("id","userId") ON DELETE CASCADE ON UPDATE CASCADE;
