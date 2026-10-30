-- AlterEnum
ALTER TYPE "EmailTokenPurpose" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "EmailToken" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "EmailToken_userId_idx" ON "EmailToken"("userId");
