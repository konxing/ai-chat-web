-- CreateEnum
CREATE TYPE "EmotionTransparency" AS ENUM ('OFF', 'IMPLICIT', 'EXPLICIT');

-- CreateTable
CREATE TABLE "CognitivePreference" (
    "userId" TEXT NOT NULL,
    "memoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "userModelEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emotionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "associationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timelineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reflectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "decisionMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adaptiveMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emotionTransparency" "EmotionTransparency" NOT NULL DEFAULT 'IMPLICIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CognitivePreference_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "CognitivePreference" ADD CONSTRAINT "CognitivePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

