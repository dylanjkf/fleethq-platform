-- Cross-instance leader election for the background scheduler: one lease row
-- per periodic task. An instance runs a tick only if it can atomically claim
-- an expired lease, so in a multi-replica deployment the job fires once, not
-- once per replica. System-level (no RLS); only the scheduler touches it via
-- the privileged fleetos_auth role.
CREATE TABLE "scheduler_leases" (
  "task" TEXT NOT NULL,
  "locked_until" TIMESTAMP(3) NOT NULL,
  "holder" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduler_leases_pkey" PRIMARY KEY ("task")
);
GRANT SELECT, INSERT, UPDATE ON "scheduler_leases" TO fleetos_auth;
