-- Make inline bytes optional and add an S3 object-key alternative. Existing
-- rows all have `data` set and `storage_key` NULL, which stays valid.
-- AlterTable
ALTER TABLE "attachments" ALTER COLUMN "data" DROP NOT NULL,
ADD COLUMN     "storage_key" TEXT;
