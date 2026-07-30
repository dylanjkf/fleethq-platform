# System Architecture — Overview

## Purpose
Define the shape of the system that makes every product principle in `00-Company/Core_Principles.md` actually true in practice: offline-first, API-first, modular, built for scale, jurisdiction-abstracted.

## High-level shape
FleetOS is a cloud platform with two primary client surfaces (DriverOS on Android tablets, FleetHQ as a web app) sitting on top of one shared backend, exposed entirely through a versioned API (`12-API/`). There is no "internal-only" backend path that bypasses the public API contract — internal clients use the same API surface a third-party integration would.

```
        DriverOS (Android)         FleetHQ (Web)
              │                        │
              └───────────┬────────────┘
                           │
                     FleetOS API (12-API/)
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   Core Services     Fleet Intelligence   Sync/Offline Layer
   (assets, operators,   (AI layer,           (queue, conflict
   jobs, maintenance,    09-AI/)              resolution)
   compliance, graph)
        │
   Primary Data Store + Fleet Graph (11-Database/)
```

## Core services (logical, not necessarily separate deployables at launch)
- **Identity & Permissions** — authentication, company membership, role/permission resolution (`14-Security/`)
- **Fleet Registry** — assets, attached units, operators, customers, depots as core records
- **Fleet Graph** — relationships and timelines across all entities (`01-Product/Fleet_Graph.md`, `01-Product/Timelines.md`)
- **Operations** — dispatch, jobs, routes (`05-Dispatch/`)
- **Workshop** — maintenance, faults, service scheduling (`06-Workshop/`)
- **Compliance** — Australian regulatory tracking, document expiry (`08-Compliance/`)
- **Asset Intelligence** — OBD/CAN ingestion and normalization (`03-Hardware/`)
- **Fleet Intelligence** — AI layer consuming the above, never gating it (`09-AI/`)
- **Sync Engine** — offline queueing, conflict resolution, delta sync for DriverOS

## Why services over a monolith, without over-engineering early
At small-fleet scale, a small number of well-separated services (not a sprawling microservice mesh) is the right starting shape — separated primarily along the boundaries above, so that scaling one area (e.g. Fleet Intelligence compute) independently of another (e.g. core CRUD operations) is possible later without a rewrite. Splitting further than this at launch adds operational cost without a corresponding benefit for the initial customer size.

## Multi-tenancy
Every record belongs to exactly one company (tenant). Cross-company access (multi-company users, subcontracted assets) is modeled explicitly through relationships, never through loosened tenant isolation. Tenant isolation is enforced at the data layer, not just the application layer.

## Jurisdiction abstraction
Compliance logic is implemented behind a jurisdiction interface (`08-Compliance/Jurisdiction_Model.md`) so "Australia" is a configured implementation of that interface rather than logic hardcoded throughout the codebase. This is what lets international expansion be additive rather than a rewrite.

## Acceptance criteria
- Every client surface (including internal ones) goes through the same versioned API.
- No tenant's data is reachable by another tenant's queries under any normal operation.
- Adding a second compliance jurisdiction requires implementing a new jurisdiction module, not touching core service logic.

## Future expansion notes
- As scale grows, individual services (particularly Fleet Intelligence and Sync) are the most likely candidates to be split into independently scaled deployments — the logical separation above is deliberately drawn along those future seams.
- See `02-Architecture/Scaling_And_Enterprise_Readiness.md` for the full tiered plan this reasoning is part of: what's already true today, what's built now, and what's designed-for-but-deferred with an explicit trigger, resolving "enterprise-grade from day one" against "don't make a small customer pay for infrastructure they don't need yet."

## Implementation notes
- **Sync Engine v0 is now live, client-side only** — DriverOS (`apps/driveros`) holds an IndexedDB-backed outbox (queued mutations) and cache (last-known-good reads), draining the outbox sequentially on reconnect (stop-on-first-failure, never skip-ahead). There is no server-side sync/queue component yet; the diagram's "Sync/Offline Layer" box is currently fully absorbed into the DriverOS client, not a backend service. See `04-DriverOS/DriverOS_Overview.md`'s implementation notes for the full design and its deliberate scope limit (no conflict resolution yet — v0's only writes are creates, and its only read is data the operator doesn't themselves edit). Promoting this to a real backend-aware sync service (with actual conflict resolution) is the concrete trigger for splitting Sync Engine out as its own deployable, per the note above.
