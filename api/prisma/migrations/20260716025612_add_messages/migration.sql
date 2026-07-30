-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('OPERATOR', 'OFFICE');

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "sender_type" "MessageSenderType" NOT NULL,
    "sender_user_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_company_id_operator_id_idx" ON "messages"("company_id", "operator_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (per prisma/migrations/*_add_row_level_security). Messages
-- are append-only and immutable once sent, so the app role gets only SELECT +
-- INSERT (never UPDATE/DELETE) — the same structural immutability the
-- timeline_events and checklist_submissions tables rely on.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON messages TO fleetos_app;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
