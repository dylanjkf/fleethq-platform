-- Composite indexes on the highest-volume tables, matching the time-range /
-- ordering query patterns the reports, feeds and dispatch board actually use.
-- All additive and CONCURRENT-safe in principle; kept plain here (brief write
-- lock is acceptable at current scale) to run inside migrate deploy.
CREATE INDEX IF NOT EXISTS "job_stops_company_id_completed_at_idx" ON "job_stops" ("company_id", "completed_at");
CREATE INDEX IF NOT EXISTS "timeline_events_company_id_occurred_at_idx" ON "timeline_events" ("company_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "notifications_company_id_recipient_user_id_created_at_idx" ON "notifications" ("company_id", "recipient_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_company_id_operator_id_created_at_idx" ON "messages" ("company_id", "operator_id", "created_at");
CREATE INDEX IF NOT EXISTS "checklist_submissions_company_id_submitted_at_idx" ON "checklist_submissions" ("company_id", "submitted_at");
CREATE INDEX IF NOT EXISTS "jobs_company_id_scheduled_at_idx" ON "jobs" ("company_id", "scheduled_at");
