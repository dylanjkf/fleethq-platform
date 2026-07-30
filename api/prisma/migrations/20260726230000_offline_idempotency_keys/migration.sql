-- Offline idempotency keys (DriverOS outbox replay safety).
--
-- Fuel entries, fault reports (maintenance jobs) and driver messages are queued
-- offline and replayed on reconnect. Without a client-supplied idempotency key,
-- a "flaky success" (the request reached the server but the response was lost)
-- replays and creates a DUPLICATE — a duplicate fuel entry silently inflates the
-- office spend rollup, a duplicate fault opens a second workshop job, a duplicate
-- message double-posts to the office. Checklists/forms already carry a client id;
-- this brings the same guarantee to the remaining create-only outbox entries.
--
-- The key is nullable (office-originated rows never set it) and unique only
-- per-company. Postgres treats NULLs as distinct, so many null-key rows coexist;
-- only a genuine (company_id, client_request_id) repeat is rejected — which is
-- exactly the duplicate a replay would produce.

ALTER TABLE "messages" ADD COLUMN "client_request_id" UUID;
ALTER TABLE "fuel_entries" ADD COLUMN "client_request_id" UUID;
ALTER TABLE "maintenance_jobs" ADD COLUMN "client_request_id" UUID;

CREATE UNIQUE INDEX "messages_company_id_client_request_id_key" ON "messages"("company_id", "client_request_id");
CREATE UNIQUE INDEX "fuel_entries_company_id_client_request_id_key" ON "fuel_entries"("company_id", "client_request_id");
CREATE UNIQUE INDEX "maintenance_jobs_company_id_client_request_id_key" ON "maintenance_jobs"("company_id", "client_request_id");
