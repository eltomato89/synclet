-- Newest live files of a folder (folder thumbnails: the mosaic picks among the newest files).
-- Raw SQL, not modeled in schema.prisma (partial index; see the header comment there).
CREATE INDEX "Item_children_mtime_idx" ON "Item" ("spaceId", "parentId", mtime DESC, id) WHERE "deletedAt" IS NULL AND type = 'file';
