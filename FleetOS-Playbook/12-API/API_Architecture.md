# API-First Architecture

## Purpose
Ensure every capability in FleetOS — used internally by DriverOS/FleetHQ or externally by a future integration/plugin — goes through one consistent, versioned API contract. This is what makes the eventual Open Platform (`18-Future/Open_Platform.md`) possible without re-architecting later.

## Requirements
- A single versioned API (e.g. `/v1/...`) is the only way any client — internal or external — reads or writes FleetOS data. There is no privileged internal-only backend path.
- Every entity described in `11-Database/Data_Model.md` has a corresponding API resource with standard create/read/update/archive operations, subject to the caller's permissions (`14-Security/Permissions_Model.md`).
- Authentication uses scoped tokens (per user, per company context) so a multi-company user's token is only ever valid for the company context it was issued for.
- Webhooks or equivalent event notifications are planned for from day one (even if only a small event set ships at launch) so integrations can react to TimelineEvents without polling.

## Workflows
- DriverOS submitting a completed Smart Checklist calls the same `POST /v1/checklists/{id}/submissions` endpoint that a hypothetical third-party integration would call.
- A permission check failure returns a clear, consistent error shape regardless of which resource was being accessed.

## Edge cases
- Versioning: breaking changes require a new API version; existing integrations on an older version must continue functioning through a defined deprecation window, not break on deploy.
- Rate limiting: needed from day one for any externally-reachable endpoint to prevent one integration or a misbehaving client from degrading service for others.
- Offline clients (DriverOS): the API must support the batch/delta sync patterns the Sync Engine needs (see `02-Architecture/System_Architecture.md`), not just simple single-record CRUD.

## Technical considerations
- API contracts are the artifact that should be documented and versioned as carefully as this Playbook itself — API documentation is a first-class deliverable, not an afterthought generated from code comments only.

## Acceptance criteria
- No feature ships that is only reachable through a non-API internal code path.
- A permission-denied request returns a consistent, documented error shape across every resource.
- API versioning supports at least one prior version running alongside the current one during a migration window.

## Future expansion notes
- The plugin marketplace (`18-Future/Open_Platform.md`) is, architecturally, "more API consumers with a discovery and billing layer on top" — this file's discipline (one contract, properly versioned, permission-checked) is what makes that additive rather than a rebuild.

## Implementation notes (foundation milestone, `apps/api`)
- Versioning is implemented as a URI prefix (`/v1/...`) via NestJS's built-in URI versioning, matching this file's `/v1/...` example literally.
- The documented error shape every endpoint returns, success or failure, is:
  ```json
  { "error": { "code": "SOME_CODE", "message": "Human-readable message.", "...": "resource-specific extra fields, e.g. requiredPermission" } }
  ```
  This is enforced by one global exception filter (`src/common/filters/http-exception.filter.ts`), not left to each controller to shape individually — so "a consistent, documented error shape across every resource" is structural, not a convention someone can forget to follow on a new endpoint.
- Authentication is a scoped JWT carrying `{ sub: userId, companyId, membershipId }` — deliberately not the caller's resolved permissions (see `14-Security/Permissions_Model.md`'s implementation notes on why those are resolved per-request instead).
- Not yet built in this milestone: webhooks/event notifications, rate limiting, and the batch/delta sync patterns offline clients will need — all called out in this file's Requirements/Edge cases above, all deferred rather than skipped. There is also no second API version running yet (nothing to be backward-compatible with until a breaking change actually ships).
- List endpoints (`GET /v1/assets`, `GET /v1/operators`, `GET /v1/users`, `GET /v1/roles`) use offset-based pagination (`page`/`pageSize`) by design, not by oversight — switching to cursor/keyset pagination before real production data volume exists would be optimizing before it hurts, and this is a deliberately deferred, triggered decision. See `02-Architecture/Scaling_And_Enterprise_Readiness.md` for the trigger (a tenant table exceeding ~100k rows, or a real slow-paging report) and why a half-wired cursor field wasn't added speculatively.
