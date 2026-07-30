# Deployment & CI/CD — Overview

## Purpose
Define how FleetOS ships safely and frequently without risking the offline-first and multi-tenant guarantees this repository requires.

## Requirements
- Standard environment progression: local → staging → production, with staging as a full-fidelity replica of production (including a representative multi-tenant dataset) used to verify tenant isolation and compliance rule correctness before release.
- API versioning discipline (`12-API/API_Architecture.md`) is enforced at deploy time — a breaking change cannot ship without a new version and a defined deprecation plan for the old one.
- DriverOS releases must account for tablets that may be offline for extended periods (a courier vehicle out of signal range) — the app must handle "skipped" update cycles gracefully, never forcing an update before the device can reach the store/update server, and never breaking sync compatibility with a backend that's since moved on.
- Rollback plan required for every production deploy, given the operational cost of an outage to a business actively running its fleet on the platform.

## Edge cases
- A DriverOS tablet running several versions behind (out of signal for weeks): sync protocol must be backward-compatible within a defined support window, with a clear forced-update path once that window is exceeded.

## Acceptance criteria
- Every production deploy has a tested rollback path.
- Staging environment testing includes multi-tenant isolation and compliance-rule verification before any release touching those areas.

## Future expansion notes
- As the customer base grows past the initial courier-company segment, blue/green or canary deployment strategies become worth the operational investment; not necessary at initial scale but the deployment pipeline should be designed so introducing them later is additive.

## Implementation notes (enterprise readiness review, `apps/api`)
- `GET /health` (liveness) and `GET /health/ready` (readiness, checks Postgres connectivity) now exist, deliberately outside the `/v1/` versioning scheme since they're infra endpoints a load balancer/orchestrator checks, not the business API contract. Readiness — not liveness — is what should gate traffic routing during a rolling deploy, so a transient DB blip doesn't cause an unnecessary instance restart.
- `app.enableShutdownHooks()` is now enabled — without it, a rolling deploy's SIGTERM to an outgoing instance would hard-kill in-flight requests instead of letting lifecycle hooks (Prisma disconnect, etc.) run first. This was a real gap, not a hypothetical one.
- Connection pool sizing guidance is documented in `apps/api/.env.example` for when a second concurrent app instance is deployed — see `02-Architecture/Scaling_And_Enterprise_Readiness.md` for the full reasoning and the PgBouncer/managed-pooler trigger.
- Structured (JSON) logging (`nestjs-pino`) is now the default for every request, replacing plain-text console output — ships to any log aggregator with zero rework once one exists.
