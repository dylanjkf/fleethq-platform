-- Self-serve free-trial window on Company. Set at signup (14 days); entitlements
-- grant the Trial tier while now < trial_ends_at, then fall back to Free.
ALTER TABLE "companies" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
