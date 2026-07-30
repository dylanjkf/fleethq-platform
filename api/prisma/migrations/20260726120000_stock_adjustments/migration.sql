-- Stock adjustment ledger: every manual quantity change to a stock item, with
-- the reason the operator gave and who made it.
--
-- The AdjustStock endpoint already accepted a `reason` and the FleetHQ dialog
-- already collected one, but the service discarded it — a warehouse operator
-- could type "5 damaged in transit" and it vanished. A paid warehouse module
-- needs to answer "why did the count change?", so the reason now lands here as
-- an immutable append-only row, alongside the delta and the resulting quantity.

CREATE TABLE "stock_adjustments" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "company_id"     UUID         NOT NULL,
  "stock_item_id"  UUID         NOT NULL,
  "delta"          DOUBLE PRECISION NOT NULL,
  "quantity_after" DOUBLE PRECISION NOT NULL,
  "reason"         TEXT,
  "actor_user_id"  UUID,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "stock_adjustments"
  ADD CONSTRAINT "stock_adjustments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_adjustments"
  ADD CONSTRAINT "stock_adjustments_stock_item_id_fkey"
  FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_adjustments"
  ADD CONSTRAINT "stock_adjustments_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The history-of-one-item lookup.
CREATE INDEX "stock_adjustments_stock_item_id_created_at_idx"
  ON "stock_adjustments"("stock_item_id", "created_at" DESC);

-- Same RLS pattern as every other tenant table: rows are visible/writable only
-- within the caller's company, FORCEd so even the table owner is subject to it.
ALTER TABLE "stock_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "stock_adjustments_tenant_isolation" ON "stock_adjustments"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- The runtime role needs table privileges — RLS narrows visible rows but does
-- not itself grant access. Append-only ledger: SELECT + INSERT, no UPDATE/DELETE.
GRANT SELECT, INSERT ON "stock_adjustments" TO fleetos_app;
