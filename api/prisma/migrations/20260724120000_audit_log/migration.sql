-- Security audit log: append-only record of security-relevant events. The app
-- role gets SELECT + INSERT only (no UPDATE/DELETE) so entries are immutable;
-- the pre-tenant auth role can also insert (login / password-reset events that
-- happen before any company context exists).
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "ip" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs" ("company_id", "created_at");
CREATE INDEX "audit_logs_company_id_action_created_at_idx" ON "audit_logs" ("company_id", "action", "created_at");

-- Append-only for the app role. The BYPASSRLS auth role also needs table
-- privileges (grants are separate from RLS) to write system/pre-tenant events.
GRANT SELECT, INSERT ON "audit_logs" TO fleetos_app;
GRANT SELECT, INSERT ON "audit_logs" TO fleetos_auth;

-- Tenant isolation. Rows with a NULL company_id (system/pre-tenant events) never
-- match a tenant's GUC, so they're invisible to the app role and surface only
-- via the BYPASSRLS auth role — exactly the intended "system events aren't a
-- tenant's business" boundary.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
