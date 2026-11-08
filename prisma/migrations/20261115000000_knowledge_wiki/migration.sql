CREATE TABLE "KnowledgePage" (
"id" TEXT NOT NULL,"userId" TEXT NOT NULL,"topicKey" VARCHAR(64) NOT NULL,
"titleCiphertext" TEXT NOT NULL,"status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
"version" INTEGER NOT NULL DEFAULT 1,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "KnowledgePage_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "KnowledgePage_id_userId_key" ON "KnowledgePage"("id","userId");
CREATE UNIQUE INDEX "KnowledgePage_userId_topicKey_key" ON "KnowledgePage"("userId","topicKey");
CREATE INDEX "KnowledgePage_userId_status_idx" ON "KnowledgePage"("userId","status");
ALTER TABLE "KnowledgePage" ADD CONSTRAINT "KnowledgePage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "KnowledgeCitation" (
"pageId" TEXT NOT NULL,"memoryId" TEXT NOT NULL,"userId" TEXT NOT NULL,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "KnowledgeCitation_pkey" PRIMARY KEY ("pageId","memoryId"));
CREATE INDEX "KnowledgeCitation_userId_memoryId_idx" ON "KnowledgeCitation"("userId","memoryId");
ALTER TABLE "KnowledgeCitation" ADD CONSTRAINT "KnowledgeCitation_pageId_userId_fkey" FOREIGN KEY ("pageId","userId") REFERENCES "KnowledgePage"("id","userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCitation" ADD CONSTRAINT "KnowledgeCitation_memoryId_userId_fkey" FOREIGN KEY ("memoryId","userId") REFERENCES "MemoryItem"("id","userId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Remove a page when deletion of its last cited memory leaves it without sources.
CREATE FUNCTION "prune_empty_knowledge_page"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "KnowledgePage" p WHERE p."id" = OLD."pageId" AND p."userId" = OLD."userId"
    AND NOT EXISTS (SELECT 1 FROM "KnowledgeCitation" c WHERE c."pageId" = OLD."pageId");
  RETURN OLD;
END;
$$;
CREATE TRIGGER "knowledge_citation_prune" AFTER DELETE ON "KnowledgeCitation"
FOR EACH ROW EXECUTE FUNCTION "prune_empty_knowledge_page"();
