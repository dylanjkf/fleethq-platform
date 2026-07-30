# Integration Hub

## Purpose
FleetHQ is a Transport Management System, not a Warehouse Management System — customers already running MYOB, Xero, SAP, Cin7, Fishbowl, Odoo, a custom ERP, or nothing more sophisticated than CSV exports from a legacy system should never be forced to replace it to use FleetHQ. The Integration Hub is a generic, plugin-shaped framework so FleetHQ can connect to almost any external system with configuration, not bespoke engineering per customer.

## Requirements
- A central Integration Hub inside FleetHQ where administrators configure external systems; multiple simultaneous connections per company.
- Integration methods: CSV/Excel import and export, a generic REST poller, and generic incoming/outgoing webhooks are the v1 reference connectors. The connector interface is a plugin — SOAP, GraphQL, EDI, SFTP/FTP, ODBC, and bespoke vendor clients (SAP, Oracle, NetSuite, Dynamics, Pronto, Cin7, Fishbowl, Odoo, etc.) are each a future connector implementing the same interface, not a v1 deliverable.
- A universal data-mapping engine: external field → FleetHQ field, unlimited mappings per connection, no hardcoded field list — with transforms (uppercase/lowercase/trim, date format, unit conversion, default value, lookup table).
- A sync engine: manual and scheduled syncing, per-row success/failure tracking, a retry queue and dead-letter queue for rows that fail, sync history/logs.
- A credential vault: secrets are encrypted at rest and never round-tripped in a connection's config/list view.
- A webhook manager: incoming (signature-verified) and outgoing (signed, retried) webhooks, with a delivery log.
- Monitoring: a sync dashboard (connection health, last sync, pending dead letters, recent errors) and an error centre (every failed row with its raw payload, error, and a retry action).
- Full audit trail: every connection/credential/mapping/webhook create-edit-archive and every sync run is an audit log entry.
- Never blocks the UI — sync processing happens via the existing scheduled-jobs runner, not inline with a request.

## Workflows
- An admin creates a CSV connection targeting Customers, uploads an export from their existing accounting package, maps its columns to FleetHQ fields (with a date-format transform on their "created" column), and runs a manual sync — rows that fail validation land in the error centre with the reason, instead of aborting the whole import.
- An admin configures a REST connection polling a third-party order system every 15 minutes; new orders map into FleetHQ Jobs automatically, and a connectivity blip lands the sync as `FAILURE` on the dashboard with the next scheduled attempt visible, not a silent stop.
- An external system posts to FleetHQ's generated inbound webhook URL when a shipment status changes; the delivery is signature-verified, logged, and fed through the same mapping engine as any other sync source.

## Edge cases
- A single malformed row in an otherwise-good CSV/REST batch must not abort the batch — it becomes a dead letter, the rest of the batch still succeeds, and the sync run's status reflects partial failure.
- A connection with no credential configured yet (REST/webhook auth types other than `NONE`) should fail clearly at sync time, not silently send unauthenticated requests.

## Technical considerations
- Reuses the existing bulk-import framework (`apps/api/src/imports`) for the actual entity-create step, rather than duplicating per-entity validation — a synced row goes through the same `Create*Dto` + `class-validator` + entity-service path a manually-created or CSV-imported record does.
- Reuses the existing scheduler (`apps/api/src/scheduler/scheduler.service.ts`) for scheduled syncs and the dead-letter retry sweep, rather than introducing a second job-scheduling mechanism.
- The credential vault is genuinely new infrastructure in this codebase (no prior encryption-at-rest existed) — AES-256-GCM, keyed off an environment-provided key validated at boot, never logged, never returned by any read endpoint.
- No new third-party dependencies (HTTP client, cron parser, CSV parser, crypto library) — everything is built on Node/browser built-ins and what this codebase already has installed, matching this codebase's general preference against unnecessary dependencies.

## Acceptance criteria
- An administrator can stand up a working CSV or REST connection, map its fields, and run a sync end-to-end without engineering involvement.
- A failed row is always visible, with its raw payload and reason, and retryable — never silently dropped.
- Listing or exporting a connection's configuration never exposes a credential's secret value.

## Future expansion notes
- Bespoke connectors for named ERPs/WMS platforms (SAP, Oracle, NetSuite, Dynamics, Pronto, Cin7, Fishbowl, Odoo) and additional protocols (SOAP, GraphQL, EDI, SFTP, ODBC, message queues) are each a real, separate build against a specific customer's actual system/credentials/sandbox — the plugin interface here doesn't block adding them, but none are pre-built.
- A Developer/Integration SDK with documented interfaces, and AI-assisted mapping suggestions/failure detection, are natural later increments once there are enough real connectors and sync history to learn from.
- The barcode-scanning admin config (`01-Product/Barcode_Scanning.md`) shares this feature's "customer-configurable field mapping, no code change" philosophy and could eventually route barcode-sourced warehouse events (receiving, sorting, dispatch confirmation) through this same sync/mapping engine.

## Implementation notes (v1, `apps/api` + `apps/fleethq`)
**Built**: new module `apps/api/src/integrations/` — `IntegrationCryptoService` (AES-256-GCM credential vault, key validated at boot via `INTEGRATION_CREDENTIAL_KEY`, fails fast if missing/malformed the same way other required secrets do), `IntegrationCredentialsService` (secrets never returned by any read endpoint), `IntegrationConnectionsService` (connections + field mappings + the dashboard summary), `IntegrationTransformService`/`IntegrationMappingEngine` (the mapping engine — uppercase/lowercase/trim/date-format/unit-conversion/default-value/lookup-table transforms), `IntegrationSyncEngine` (manual + scheduled sync, dead-letter retry sweep), and `IntegrationWebhookService` (incoming + outgoing, HMAC-SHA256 signed). A real 5-field cron parser (`*`, lists, ranges, steps — `integration-cron.util.ts`) drives scheduled syncs, reusing the existing `scheduler.service.ts` tick rather than a second scheduling mechanism.

**The single most important reuse decision**: `IntegrationSyncEngine` calls the exact same `ImportsService.importAssets/Operators/Depots/Customers/AttachedUnits/ComplianceDocuments` paths the existing bulk-import feature already uses — a synced row is validated and created identically to a manually-imported one, never a parallel validation path. This required widening each entity service's `create()` `actorUserId` parameter from `string` to `string | undefined` (a SCHEDULED/webhook-triggered sync has no human actor) — `TimelineService` already attributes a missing actor to `SYSTEM`, so this is a correctness fix, not a workaround, and every touched entity's existing e2e suite still passes unchanged.

**Reference connectors**: CSV (frontend parses via the existing `parseCsvFile` utility already used by bulk-import dialogs — no new CSV library — and posts parsed rows), a generic REST poller (built-in `fetch`, `API_KEY`/`BEARER_TOKEN`/`BASIC_AUTH` auth from a linked credential, a configurable `responseArrayPath`), and a generic webhook (incoming: public `POST /v1/integrations/webhooks/in/:token`, signature-verified, feeds a single row through the same sync path; outgoing: signed, retried inline with a small bounded backoff).

**Frontend**: `apps/fleethq/src/features/integrations/` — a tabbed `IntegrationsPage` (Connections, Sync Dashboard, Error Centre, Webhooks, Credentials), with the Data Mapping Designer as a per-connection drawer off Connections rather than its own tab (mappings only make sense for one selected connection at a time).

**Known simplifications** (all documented in code comments, none blocking the architecture): dead-letter retry backoff is 2^attempts minutes capped at 24h with a 5-attempt ceiling; outgoing webhook retries are inline/bounded rather than a persisted queue (no `nextRetryAt` column on delivery logs); a webhook-triggered sync is recorded with trigger `MANUAL` (the schema's trigger enum has no `WEBHOOK` value); the inbound webhook token lookup fans out across active companies (no cross-tenant lookup table exists for a public route) — flagged as an O(1) follow-up if inbound volume needs it; credential "test" is a decrypt round-trip only, not a live call to the external system.

**No new npm dependencies** — no cron library, no HTTP client library (built-in `fetch`), no CSV library (reuses the existing one), no crypto library (Node's built-in `crypto`).
