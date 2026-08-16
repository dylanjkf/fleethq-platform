-- Weekly-report configurable recipient list (Part 4). A plain text[] on the
-- company (inherits companies' row-level security — no new tenant table). Empty
-- by default: the report then falls back to reports:view permission holders, so
-- the company's main contacts still receive it until the list is customised.
ALTER TABLE "companies"
  ADD COLUMN "weekly_report_recipients" TEXT[] NOT NULL DEFAULT '{}';
