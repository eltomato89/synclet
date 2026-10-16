-- Phase 4: Space becomes the tenant key of the file index.
-- Personal space id = user id, so every existing key (Item.ownerId, FileChange.scopeId,
-- SyncScope.userId, TrashEntry.ownerId, FileVersion.ownerId, /meta/versions/<id>/...) stays valid.
-- Columns are RENAMED (no data rewrite); the only data written are the personal Space rows and
-- the ShareLink.spaceId backfill.

-- 1. Enums and tables
CREATE TYPE "SpaceKind" AS ENUM ('personal', 'team', 'external');
CREATE TYPE "SpaceStatus" AS ENUM ('available', 'missing');
CREATE TYPE "SpaceWatch" AS ENUM ('auto', 'off');
CREATE TYPE "SpaceRole" AS ENUM ('read', 'write');

CREATE TABLE "Space" (
    "id" UUID NOT NULL,
    "kind" "SpaceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "userId" UUID,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" "SpaceStatus" NOT NULL DEFAULT 'available',
    "watch" "SpaceWatch" NOT NULL DEFAULT 'auto',
    "scanIntervalSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Group" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupMember" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

CREATE TABLE "SpaceMember" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID,
    "groupId" UUID,
    "role" "SpaceRole" NOT NULL,

    CONSTRAINT "SpaceMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Space_userId_key" ON "Space"("userId");
CREATE UNIQUE INDEX "Group_nameKey_key" ON "Group"("nameKey");
CREATE UNIQUE INDEX "SpaceMember_spaceId_userId_key" ON "SpaceMember"("spaceId", "userId");
CREATE UNIQUE INDEX "SpaceMember_spaceId_groupId_key" ON "SpaceMember"("spaceId", "groupId");

ALTER TABLE "Space" ADD CONSTRAINT "Space_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. One personal space per existing user (id = user id). rootPath depends on the container
--    config (dataRoot/username) and is filled at boot by SpacesRepo.syncPersonalRoots().
INSERT INTO "Space" ("id", "kind", "name", "rootPath", "userId", "createdAt", "updatedAt")
SELECT "id", 'personal', "username", '', "id", now(), now() FROM "User";

-- 3. Column renames (values unchanged)
ALTER TABLE "Item" RENAME COLUMN "ownerId" TO "spaceId";
ALTER TABLE "SyncScope" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "TrashEntry" RENAME COLUMN "ownerId" TO "spaceId";
ALTER TABLE "TrashEntry" ADD COLUMN "deletedBy" UUID;
ALTER TABLE "FileVersion" RENAME COLUMN "ownerId" TO "spaceId";

ALTER INDEX "Item_ownerId_parentId_idx" RENAME TO "Item_spaceId_parentId_idx";
ALTER INDEX "Item_ownerId_dev_ino_idx" RENAME TO "Item_spaceId_dev_ino_idx";
ALTER INDEX "Item_ownerId_path_idx" RENAME TO "Item_spaceId_path_idx";
ALTER INDEX "TrashEntry_ownerId_deletedAt_idx" RENAME TO "TrashEntry_spaceId_deletedAt_idx";
ALTER INDEX "FileVersion_ownerId_idx" RENAME TO "FileVersion_spaceId_idx";

-- 4. Re-point the foreign keys from User to Space; backfill ShareLink.spaceId
ALTER TABLE "Item" DROP CONSTRAINT "Item_ownerId_fkey";
ALTER TABLE "Item" ADD CONSTRAINT "Item_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncScope" DROP CONSTRAINT "SyncScope_userId_fkey";
ALTER TABLE "SyncScope" ADD CONSTRAINT "SyncScope_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShareLink" ADD COLUMN "spaceId" UUID;
UPDATE "ShareLink" SET "spaceId" = "ownerId";
ALTER TABLE "ShareLink" ALTER COLUMN "spaceId" SET NOT NULL;

-- 5. Raw partial indexes (not modeled in schema.prisma) under their new names.
--    The column rename already re-pointed them; only the names change.
ALTER INDEX "Item_owner_path_live_key" RENAME TO "Item_space_path_live_key";
ALTER INDEX "Item_owner_mtime_idx" RENAME TO "Item_space_mtime_idx";
