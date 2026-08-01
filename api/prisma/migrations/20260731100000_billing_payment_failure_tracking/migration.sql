ALTER TABLE "companies" ADD COLUMN "payment_failure_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "companies" ADD COLUMN "last_payment_failed_at" TIMESTAMP(3);
ALTER TABLE "companies" ADD COLUMN "next_payment_attempt_at" TIMESTAMP(3);
