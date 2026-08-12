-- One active (non-archived) DELIVERY template per company, so completeStop has a
-- single unambiguous evidence requirement to resolve. Separate migration from
-- the ALTER TYPE ... ADD VALUE that introduced 'DELIVERY': Postgres forbids
-- using a freshly-added enum value in the same transaction it was added in, and
-- this predicate references it.
CREATE UNIQUE INDEX "form_templates_one_active_delivery_idx"
  ON "form_templates" ("company_id")
  WHERE "target_context" = 'DELIVERY' AND "archived_at" IS NULL;
