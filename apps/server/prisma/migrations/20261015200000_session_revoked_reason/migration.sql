-- CreateEnum
CREATE TYPE "SessionRevokeReason" AS ENUM ('rotated', 'admin', 'logout');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "revokedReason" "SessionRevokeReason";
