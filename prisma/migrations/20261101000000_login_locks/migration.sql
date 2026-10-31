-- CreateTable
CREATE TABLE "LoginLock" (
    "ip" VARCHAR(64) NOT NULL,
    "fails" INTEGER NOT NULL DEFAULT 0,
    "firstFailAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginLock_pkey" PRIMARY KEY ("ip")
);

-- CreateIndex
CREATE INDEX "LoginLock_lockedUntil_idx" ON "LoginLock"("lockedUntil");
