-- Bulk operations of the web multi-select (copy / move / delete jobs).
-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "targetId" TEXT,
    "targetName" TEXT,
    "nextIndex" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "doneItems" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "doneBytes" BIGINT NOT NULL DEFAULT 0,
    "conflict" JSONB,
    "policy" TEXT,
    "results" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Operation_userId_status_idx" ON "Operation"("userId", "status");

-- CreateIndex
CREATE INDEX "Operation_finishedAt_idx" ON "Operation"("finishedAt");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

