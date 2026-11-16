ALTER TABLE "Message" ALTER COLUMN "sticker" TYPE VARCHAR(40);

CREATE TABLE "PersonalSticker" (
    "id" VARCHAR(33) NOT NULL,
    "userId" TEXT NOT NULL,
    "labelCiphertext" TEXT NOT NULL,
    "imageCiphertext" BYTEA NOT NULL,
    "mime" VARCHAR(32) NOT NULL,
    "size" INTEGER NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalSticker_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonalSticker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PersonalSticker_userId_digest_key" ON "PersonalSticker"("userId", "digest");
CREATE INDEX "PersonalSticker_userId_createdAt_idx" ON "PersonalSticker"("userId", "createdAt");
