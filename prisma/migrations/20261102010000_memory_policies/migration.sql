-- CreateEnum
CREATE TYPE "MemoryContext" AS ENUM ('GENERAL', 'TECHNICAL_PROJECT', 'LEARNING', 'PERSONAL_GOAL', 'PERSONAL_REFLECTION', 'EMOTIONAL_SUPPORT', 'DECISION_MAKING');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('FACT', 'PREFERENCE', 'GOAL', 'PROJECT', 'DECISION', 'EMOTION');

-- CreateEnum
CREATE TYPE "MemoryRetention" AS ENUM ('FOREVER', 'UNTIL_SUPERSEDED', 'DAYS_30', 'DAYS_90', 'SESSION_ONLY');

-- CreateTable
CREATE TABLE "MemoryPolicy" (
    "userId" TEXT NOT NULL,
    "context" "MemoryContext" NOT NULL,
    "allowPersistence" BOOLEAN NOT NULL DEFAULT false,
    "allowedMemoryTypes" "MemoryType"[] DEFAULT ARRAY[]::"MemoryType"[],
    "requireConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "retention" "MemoryRetention" NOT NULL DEFAULT 'SESSION_ONLY',
    "allowUserProfile" BOOLEAN NOT NULL DEFAULT false,
    "allowReflection" BOOLEAN NOT NULL DEFAULT false,
    "allowAssociation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryPolicy_pkey" PRIMARY KEY ("userId","context")
);

-- AddForeignKey
ALTER TABLE "MemoryPolicy" ADD CONSTRAINT "MemoryPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

