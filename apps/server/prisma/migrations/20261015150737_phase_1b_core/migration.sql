-- CreateEnum
CREATE TYPE "DerivativeKind" AS ENUM ('thumb', 'text');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'unsupported');

-- AlterTable
ALTER TABLE "TrashEntry" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DerivativeJob" (
    "sha" TEXT NOT NULL,
    "kind" "DerivativeKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "meta" JSONB,
    "lockedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DerivativeJob_pkey" PRIMARY KEY ("sha","kind")
);

-- CreateTable
CREATE TABLE "ItemText" (
    "sha" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemText_pkey" PRIMARY KEY ("sha")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "allowUpload" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DerivativeJob_status_kind_idx" ON "DerivativeJob"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_tokenHash_key" ON "ShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ShareLink_ownerId_idx" ON "ShareLink"("ownerId");

-- CreateIndex
CREATE INDEX "ShareLink_itemId_idx" ON "ShareLink"("itemId");

-- CreateIndex
CREATE INDEX "TrashEntry_expiresAt_idx" ON "TrashEntry"("expiresAt");

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is STABLE; an IMMUTABLE wrapper is required for index expressions.
CREATE OR REPLACE FUNCTION synclet_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

ALTER TABLE "ItemText" ADD COLUMN tsv tsvector;
CREATE INDEX "ItemText_tsv_idx" ON "ItemText" USING GIN (tsv);
CREATE INDEX "Item_name_trgm_idx" ON "Item" USING GIN (synclet_unaccent(lower(name)) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX "Item_owner_mtime_idx" ON "Item" ("ownerId", mtime DESC) WHERE "deletedAt" IS NULL AND type = 'file';
CREATE INDEX "Item_contentHash_idx" ON "Item" ("contentHash") WHERE "deletedAt" IS NULL;
