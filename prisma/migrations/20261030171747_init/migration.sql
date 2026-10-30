-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProviderOwner" AS ENUM ('GLOBAL', 'USER');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('COMPLETE', 'PARTIAL', 'ERROR');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('IMAGE', 'FILE', 'AUDIO');

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('REGISTER', 'RESET');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "displayName" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "csrfHash" VARCHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titleCiphertext" TEXT NOT NULL,
    "modelProviderId" TEXT,
    "modelId" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "modelId" VARCHAR(128),
    "providerId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'COMPLETE',
    "errorCode" VARCHAR(64),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "kind" "AttachmentKind" NOT NULL,
    "originalNameCiphertext" TEXT NOT NULL,
    "mime" VARCHAR(128) NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "storageKey" VARCHAR(128) NOT NULL,
    "extractedTextCiphertext" TEXT,
    "chunksCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL,
    "ownerType" "ProviderOwner" NOT NULL,
    "userId" TEXT,
    "name" VARCHAR(64) NOT NULL,
    "baseUrl" VARCHAR(512) NOT NULL,
    "apiKeyCiphertext" TEXT NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "params" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpRule" (
    "id" TEXT NOT NULL,
    "cidr" VARCHAR(64) NOT NULL,
    "label" VARCHAR(128),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMatchedAt" TIMESTAMP(3),

    CONSTRAINT "IpRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAccessLog" (
    "id" TEXT NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "reason" VARCHAR(128),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "identifier" VARCHAR(254),
    "ip" VARCHAR(64) NOT NULL,
    "userAgent" VARCHAR(512),
    "success" BOOLEAN NOT NULL,
    "reason" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" VARCHAR(128) NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "targetType" VARCHAR(64),
    "targetId" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "status" "AuditStatus" NOT NULL DEFAULT 'SUCCESS',
    "error" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "username" VARCHAR(32),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Chat_userId_updatedAt_idx" ON "Chat"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Chat_modelProviderId_idx" ON "Chat"("modelProviderId");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_userId_chatId_idx" ON "Attachment"("userId", "chatId");

-- CreateIndex
CREATE INDEX "Attachment_userId_createdAt_idx" ON "Attachment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "AiProvider_ownerType_enabled_idx" ON "AiProvider"("ownerType", "enabled");

-- CreateIndex
CREATE INDEX "AiProvider_userId_idx" ON "AiProvider"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IpRule_cidr_key" ON "IpRule"("cidr");

-- CreateIndex
CREATE INDEX "IpRule_enabled_idx" ON "IpRule"("enabled");

-- CreateIndex
CREATE INDEX "IpRule_expiresAt_idx" ON "IpRule"("expiresAt");

-- CreateIndex
CREATE INDEX "IpAccessLog_createdAt_idx" ON "IpAccessLog"("createdAt");

-- CreateIndex
CREATE INDEX "IpAccessLog_ip_createdAt_idx" ON "IpAccessLog"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "IpAccessLog_allowed_createdAt_idx" ON "IpAccessLog"("allowed", "createdAt");

-- CreateIndex
CREATE INDEX "LoginLog_createdAt_idx" ON "LoginLog"("createdAt");

-- CreateIndex
CREATE INDEX "LoginLog_userId_createdAt_idx" ON "LoginLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginLog_ip_createdAt_idx" ON "LoginLog"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "EmailToken_email_purpose_createdAt_idx" ON "EmailToken"("email", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "EmailToken_expiresAt_idx" ON "EmailToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProvider" ADD CONSTRAINT "AiProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRule" ADD CONSTRAINT "IpRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginLog" ADD CONSTRAINT "LoginLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
