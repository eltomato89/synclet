-- CreateEnum
CREATE TYPE "VersionSource" AS ENUM ('api', 'office', 'restore');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "officeKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sha" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "source" "VersionSource" NOT NULL,
    "storePath" TEXT NOT NULL,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAuthCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "passwordLoginForUsers" BOOLEAN NOT NULL DEFAULT true,
    "oidcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecretEnc" TEXT,
    "oidcScopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "oidcButtonLabel" TEXT NOT NULL DEFAULT 'Single Sign-on',
    "oidcUsernameClaim" TEXT NOT NULL DEFAULT 'preferred_username',
    "oidcGroupsClaim" TEXT NOT NULL DEFAULT 'groups',
    "oidcAllowedGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "oidcAdminGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "oidcLinkByEmail" BOOLEAN NOT NULL DEFAULT false,
    "forwardAuthEnabled" BOOLEAN NOT NULL DEFAULT false,
    "forwardAuthUserHeader" TEXT NOT NULL DEFAULT 'Remote-User',
    "forwardAuthEmailHeader" TEXT NOT NULL DEFAULT 'Remote-Email',
    "forwardAuthNameHeader" TEXT NOT NULL DEFAULT 'Remote-Name',
    "forwardAuthGroupsHeader" TEXT NOT NULL DEFAULT 'Remote-Groups',
    "forwardAuthTrustedProxies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forwardAuthAdminGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forwardAuthAllowedGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "AuthSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileVersion_itemId_createdAt_idx" ON "FileVersion"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "FileVersion_ownerId_idx" ON "FileVersion"("ownerId");

-- CreateIndex
CREATE INDEX "FileVersion_sha_idx" ON "FileVersion"("sha");

-- CreateIndex
CREATE UNIQUE INDEX "AppAuthCode_codeHash_key" ON "AppAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "AppAuthCode_expiresAt_idx" ON "AppAuthCode"("expiresAt");
