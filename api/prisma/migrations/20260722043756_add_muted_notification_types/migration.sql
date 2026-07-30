-- AlterTable
ALTER TABLE "users" ADD COLUMN     "muted_notification_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
