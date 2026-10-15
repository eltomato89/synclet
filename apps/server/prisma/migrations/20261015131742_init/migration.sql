-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('folder', 'file');

-- CreateEnum
CREATE TYPE "ChangeOp" AS ENUM ('upsert', 'delete');

-- CreateTable
CREATE TABLE "ServerConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "serverId" UUID NOT NULL,
    "jwtSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "installationId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SyncDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "parentId" UUID,
    "type" "ItemType" NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mtime" TIMESTAMP(3) NOT NULL,
    "ino" BIGINT,
    "dev" BIGINT,
    "contentHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncScope" (
    "userId" UUID NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "minSeq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "SyncScope_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "FileChange" (
    "scopeId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "itemId" UUID NOT NULL,
    "itemType" "ItemType" NOT NULL,
    "op" "ChangeOp" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileChange_pkey" PRIMARY KEY ("scopeId","seq")
);

-- CreateTable
CREATE TABLE "TrashEntry" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "type" "ItemType" NOT NULL,
    "name" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "storePath" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_provider_subject_key" ON "Identity"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncDevice_tokenHash_key" ON "SyncDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "SyncDevice_userId_idx" ON "SyncDevice"("userId");

-- CreateIndex
CREATE INDEX "Item_ownerId_parentId_idx" ON "Item"("ownerId", "parentId");

-- CreateIndex
CREATE INDEX "Item_ownerId_dev_ino_idx" ON "Item"("ownerId", "dev", "ino");

-- CreateIndex
CREATE INDEX "Item_ownerId_path_idx" ON "Item"("ownerId", "path");

-- CreateIndex
CREATE INDEX "FileChange_scopeId_itemId_idx" ON "FileChange"("scopeId", "itemId");

-- CreateIndex
CREATE INDEX "FileChange_at_idx" ON "FileChange"("at");

-- CreateIndex
CREATE INDEX "TrashEntry_ownerId_deletedAt_idx" ON "TrashEntry"("ownerId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncDevice" ADD CONSTRAINT "SyncDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncScope" ADD CONSTRAINT "SyncScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Live paths are unique per user; tombstones may share paths.
CREATE UNIQUE INDEX "Item_owner_path_live_key" ON "Item" ("ownerId", "path") WHERE "deletedAt" IS NULL;
