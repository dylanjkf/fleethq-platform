-- FleetHQ Internal Administration Platform — Phase 5d: cross-tenant fleet
-- views (21-Admin-Platform/Overview.md). No new tables: `assets`/`operators`
-- were already granted to `fleetos_admin` by admin_platform_foundation.
-- This adds read access to `integration_connections` ONLY — never
-- `integration_credentials` (holds encrypted secrets: encrypted_payload,
-- encryption_iv, encryption_tag). The admin platform's cross-tenant
-- "integrations" view answers "which connectors are configured and are they
-- syncing", not "what are this company's API keys" — least exposure, even
-- though the payload is encrypted at rest.
GRANT SELECT ON integration_connections TO fleetos_admin;
