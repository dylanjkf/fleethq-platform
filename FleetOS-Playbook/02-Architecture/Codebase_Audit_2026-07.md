# FleetOS Codebase Audit & Refactor Report — 2026-07

**Reviewer role:** senior architect / staff engineer taking ownership before a funding round.
**Scope:** entire monorepo (`apps/api`, `apps/fleethq`, `apps/driveros`) + Prisma schema, migrations, tests, infra.
**Verdict up front:** this is **not** a throwaway prototype. It is a well-structured, multi-tenant SaaS with disciplined patterns, strict typing, and a real test suite. The honest work here is *validation + targeted hardening*, not a teardown. Aggressively rewriting clean code would add risk for no gain — and this report says so where that applies.

> **Update 2026-07-23:** all ten "Next engineering priorities" (bottom of this report) have since been executed, then a further scale/quality pass (N+1 removal, index-verified scale test, vendor bundle-splitting, more tests). Scores below reflect that follow-up — see the CHANGELOG entries "Hardening pass" and "Scale + quality pass".

---

## Baseline metrics (measured, not estimated)

| Metric | Value |
|---|---|
| Source files (ts/tsx, excl. node_modules/dist) | **506** (api 262, fleethq 190, driveros 54) |
| Source LOC | **~42,100** (api 17.3k, fleethq 20.9k, driveros 3.9k) |
| API test LOC | ~9,070 |
| Prisma models | 47 |
| Migrations | 44 (manually authored, `migrate deploy`) |
| Index declarations in schema | 49 — **every tenant-scoped model has a `companyId` index** |
| Prod dependencies | api 26, fleethq 27 (was 30), driveros 9 |
| `any` / `as any` in 42k LOC | **4** |
| Stray `console.log/debug` in src | **0** |
| Raw SQL calls | **2**, both parameterized tagged-templates; **0** `*Unsafe` variants |
| Hardcoded secrets in src | **0** |
| API tests | 66 suites / 275 tests passing |

---

## Phase 1 — Architecture report

**Application structure.** A three-app monorepo under `apps/`:
- **`api`** — NestJS + Prisma + PostgreSQL. Feature-modular: each domain is a folder of `*.controller.ts` / `*.service.ts` / `dto/` / `*.module.ts`. Cross-cutting concerns live under `common/` (guards, decorators, permission catalog), `prisma/` (tenant-aware client), `auth/`.
- **`fleethq`** — React 19 + Vite + TypeScript office app. Feature-folder architecture (`features/<domain>/`), a thin `api/` client layer (one file per backend module), `components/ui/` design-system primitives, `hooks/`, `app/` (router, providers), TanStack Query for server state.
- **`driveros`** — React PWA for drivers. Same shape, plus an offline layer (`lib/offline-db.ts` IndexedDB outbox, `lib/sync-engine.ts` replay, `public/sw.js` service worker).

**Frontend architecture.** Clean separation: **pages/features** (route-level) → **components** (reusable UI) → **hooks** → **api services** (typed HTTP) → **TanStack Query** cache. No global mutable store; server state is the source of truth, local UI state is component-local. This is the right call for a CRUD-heavy ops tool and avoids Redux-style ceremony.

**Backend architecture.** Textbook NestJS layering: **Controller** (HTTP + `@RequirePermission`) → **Service** (business logic, always inside `prisma.withTenant`) → **Prisma** (data). DTOs with `class-validator` at the edge. Framework-agnostic helpers (e.g. `provisionCompany`, `TimelineService`) are plain functions so the seed script and Nest DI share one implementation.

**Database design.** 47 models, snake_case columns via `@map`, UUID PKs, soft-delete via `archivedAt`, `createdAt/updatedAt` everywhere. Row-Level Security is the backbone: every tenant table has a policy `company_id = current_setting('app.current_company_id')`; the app connects as a non-superuser `fleetos_app` role, and `PrismaService.withTenant(companyId, …)` sets the GUC per transaction. Migrations bypass RLS via the schema-owning role.

**API structure.** Versioned (`/v1/...`), REST, one controller per resource, consistent error envelope (`{ error: { code, message, … } }`). `@Public()` opts specific routes out of JWT (login, signup, Stripe webhook, GPS ingest). Permission guard no-ops when a route declares no permission.

**Authentication flow.** Company-issued username/password → JWT session token carrying `{ userId, companyId, membershipId }`. Multi-company users get a pre-auth token + company picker. Password reset / email verify / invite via signed tokens + SES. A narrowly-scoped `SystemPrismaService` (SELECT-only, BYPASSRLS) handles the one keyless lookup (login) RLS can't express.

**State management.** Server state via TanStack Query (cache keys per resource, `refetchInterval` on live views). Auth state via a small React context. No over-engineered client store.

**External integrations.** Stripe (checkout/portal/signature-verified webhook), AWS SES (email, behind config), Web Push/VAPID, S3 (attachments, behind config), OpenStreetMap tiles (no key). All degrade gracefully when unconfigured.

**Deployment architecture.** Terraform modules under `infra/` (ECS/RDS/Secrets Manager/backups/monitoring). Both frontends are static Vite builds. Local dev via Postgres + `ts-node` API + Vite. *Note: deployment is deliberately deferred per the founder's Commercial_Priority directive until the courier vertical is feature-complete.*

### Good decisions
- **Multi-tenant via Postgres RLS**, not app-layer `where companyId` alone — defence in depth; a forgotten filter can't leak across tenants.
- **Granular permissions** (capability strings, roles are bundles) — never `if role === admin`. Scales to enterprise RBAC.
- **Generic domain language** (Asset/Operator/Attached Unit) — no road-specific naming to unwind for mining/construction later.
- **Every entity has an immutable timeline** — audit/compliance built in, not bolted on.
- **Offline-first DriverOS** — genuine IndexedDB outbox + ordered replay, not a manifest gesture.
- **Boring, proven stack** — Nest/Prisma/Postgres/React/Vite. No exotic frameworks.
- **Strict typing + real e2e tests** as a standing discipline.

### Bad decisions / debt (honest)
- **Unbounded `findMany`** on high-volume tables (no default row cap) — the single most material scaling risk (see Phase 7).
- **Permission catalog duplicated** between `api` and `fleethq` (deliberate; documented) with no automated parity check — a latent drift risk.
- **A few god services** (`jobs.service.ts` at 915 lines) mixing several responsibilities.
- **No route-level code-splitting** in FleetHQ → a single ~1.3 MB first-load JS chunk.
- **GPS tables have no RLS backstop** (service-layer filter only) — latent, documented, currently correct.

### Technical risks / future scaling problems
- Very large tenants (10k+ jobs, 100k+ stops/timeline events) will feel the unbounded queries and un-split bundles first.
- Scheduled work (digest email, trial expiry, compliance alerts) is not yet automated — it relies on manual/API triggers.
- The two-frontend duplication is small today but will grow if not watched.

---

## Phase 2 — AI/"vibe-coding" problem hunt (findings *before* changes)

Searched for the usual prototype tells. Result: **remarkably few.**

| Looked for | Found |
|---|---|
| Duplicate components/functions/copy-paste logic | Minor: ~28 *same-named* files across the two frontends, but only small infra (`client.ts`, `token-store.ts`, `register-sw.ts`) is near-identical (9–15 differing lines each). Not true logic duplication. |
| Unnecessary/over-engineered abstractions | None material. Patterns are consistent, not layered for their own sake. |
| Dead code | `tooltip.tsx` + `breadcrumbs.tsx` (2 unused UI primitives, 52 LOC) — **removed this pass**. `ComingSoonPage` already removed earlier this session. |
| Unused dependencies | `date-fns`, `@radix-ui/react-popover`, `@radix-ui/react-tooltip` (freed by the dead-file deletion) — **removed this pass**. Everything else my scan flagged was a false positive (config-file or peer-dep usage). |
| Temporary/placeholder files | None. No `TODO`/`FIXME` in src; placeholder widgets already replaced with real ones. |
| Hardcoded values / secrets | No secrets in src. Config via env with safe unconfigured fallbacks. |
| Poor naming / inconsistent formatting | Consistent; oxlint clean bar one pre-existing fast-refresh warning. |
| Security risks / SQL injection | None found (Phase 6). |
| Poor error handling / missing validation | DTO validation at every edge; consistent error envelope; ErrorBoundary + typed API errors on the frontends. |
| Fragile DB queries | Only the unbounded-`findMany` pattern (Phase 7). |

**Conclusion:** the "rushed prototype full of debt" premise does not match the evidence. The genuine debt is narrow and listed above.

---

## Phase 3 — Code reduction (executed)

Applying "does this need to exist?" honestly:
- **Deleted** `apps/fleethq/src/components/ui/tooltip.tsx` and `breadcrumbs.tsx` — zero importers.
- **Removed** 3 now-unused dependencies from `fleethq/package.json` (`@radix-ui/react-tooltip`, `@radix-ui/react-popover`, `date-fns`).
- (Earlier in the same session: removed the orphaned `ComingSoonPage`, deleted the `PlaceholderWidget` once its widgets became real, and corrected stale `severity` comments.)

**Deliberately *not* reduced** (reduction would add complexity, violating the brief's own rules):
- **Cross-frontend infra into a shared package** — would couple two independently-deployed apps' builds to save ~150 lines. Net-negative. Left as a conscious decision.
- **Permission catalog de-duplication** — a shared package is overkill; the right guard is a cheap CI parity check (Phase 10 / Next Priorities), not a new abstraction layer.

---

## Phase 4 — Architecture / separation of concerns

Already met. Frontend has clear Components / Pages(features) / Hooks / Services(api) / Utilities / State(TanStack Query) separation. Backend has clear Controller / Service / Data(Prisma) / Auth / Validation(DTO) / Business-logic separation. No re-architecture warranted. The only structural refinement worth doing later is **splitting the largest services along their natural seams** (e.g. `jobs.service` → dispatch-assignment vs stop-lifecycle) — tracked, not urgent.

## Phase 5 — Database review

- **Schema design:** consistent, normalized, soft-delete + timestamps everywhere, JSON columns used judiciously (custom fields, form/checklist definitions).
- **Relationships:** explicit FKs; join tables where needed (memberships, role-permissions, parts usage).
- **Indexes:** 49 declarations; **every tenant model is indexed on `companyId`** (verified programmatically) — exactly right for RLS scan patterns. *Next-level:* add **composite** indexes (`companyId, <hot filter/sort>`) on the highest-volume tables once load-tested (e.g. `JobStop(companyId, completedAt)`).
- **Naming:** snake_case DB via `@map`, camelCase in code — conventional and consistent.
- **Migration safety:** additive, hand-reviewed SQL; the new `trial_ends_at` is a nullable add (safe). No destructive migrations observed without intent.
- **Duplicate tables / unnecessary fields:** none found.

## Phase 6 — Security review

- **AuthN/AuthZ:** JWT sessions, granular permission guard on every mutating route; last-admin lockout guard exists. Multi-tenant isolation via RLS **and** explicit filters (defence in depth).
- **Exposed secrets:** none in source; env-based with safe fallbacks.
- **SQL injection:** only 2 raw calls, both Prisma tagged-templates (parameterized). No `queryRawUnsafe`. **No injection surface.**
- **Unsafe endpoints:** `@Public()` routes are minimal and each defends itself (Stripe signature verification, GPS device-key auth, throttled signup).
- **Input validation:** `class-validator` DTOs at every boundary; throttling on auth/signup.
- **File uploads:** attachments are typed/size-considered and stored behind config (Postgres or S3).
- **Data leaks:** RLS prevents cross-tenant reads; `SystemPrismaService` is SELECT-only and single-call-site.
- **Residual:** GPS tables rely on service-layer tenant filters (no RLS backstop) — currently correct, add a backstop + test (Phase 10). No fixes required this pass — nothing exploitable was found.

## Phase 7 — Performance review

- **Slow queries:** indexing is good; the real risk is **118 `findMany` calls without an explicit `take`**. On small tenants this is fine; on enterprise data (large jobs/stops/timeline/notifications tables) it invites unbounded result sets and memory pressure. **Top perf priority** (Phase 10 #1).
- **Unnecessary API calls:** TanStack Query dedupes/caches well; live views poll deliberately.
- **Large components / bundle:** FleetHQ ships a single ~1.3 MB JS chunk — **no route-level code-splitting**. Real first-load cost; low-risk to fix with `React.lazy` per route (Phase 10 #2).
- **Excessive dependencies:** lean (only 3 unused, now removed).

## Phase 8 — Testing foundation

- **API:** 66 e2e suites / 275 tests covering tenant isolation, permissions, the courier loop, billing/webhooks, compliance, offline replay. Strong.
- **Frontend:** vitest is wired (`test/setup.ts`) with lighter coverage. **Priority:** integration tests for the critical FleetHQ flows (dispatch create → assign → complete, POD capture) and the offline sync engine.

## Phase 9 — Documentation

The Playbook (`FleetOS-Playbook/`) is unusually thorough — numbered domains, per-feature specs with implementation notes, a maintained CHANGELOG, and a CLAUDE.md operating contract. **Gap:** a top-level engineering `README` (setup, architecture-at-a-glance, dev workflow, folder map) aimed at a new engineer joining cold, distinct from the product Playbook. Tracked as Phase 10 #? / Next Priorities.

## Phase 10 — FleetOS-specific scaling review

| Capability | Supported? | Notes |
|---|---|---|
| Multi-company SaaS | ✅ | RLS + per-tenant provisioning from day one. |
| Multiple users / company | ✅ | Memberships + multi-company login. |
| Permissions & roles | ✅ | Granular capabilities; editable role bundles. |
| Offline capability | ✅ | DriverOS IndexedDB outbox + ordered replay + SW. |
| Mobile/tablet usage | ✅ | DriverOS PWA, large touch targets; header overflow fixed. |
| Future AI integrations | ✅ | AI features have manual fallbacks (principle enforced). |
| External integrations | ✅ (API-first) | Publish OpenAPI to fully deliver the promise (Phase 10 #10). |
| Large operational data | ⚠️ | Pagination hardening needed before very large tenants. |
| Enterprise customers | ⚠️ | Add SSO/audit-export/scheduled jobs/observability depth over time. |

**Nothing structural prevents scaling.** The blockers-at-scale are pagination and bundle-splitting — both bounded, low-risk, and sequenced below.

---

## Proposed changes · impact · risk (the ones NOT executed this pass)

| # | Change | Impact | Risk | Recommendation |
|---|---|---|---|---|
| A | Default row caps + cursor pagination on high-volume list endpoints; lint to forbid unbounded `findMany` on hot models | High (scale) | Medium (touches many call sites + client) | **Do next**, incrementally per endpoint with tests |
| B | Route-level `React.lazy` code-splitting in FleetHQ | Medium (first-load) | Low | Do next |
| C | CI check asserting permission-catalog parity (api ↔ fleethq) | Medium (safety) | Very low | Do next — cheap insurance |
| D | Scheduled-jobs runner (digest, trial expiry, compliance alerts) | Medium | Low–Med | Do soon |
| E | Split `jobs.service.ts` (and other >500-line services) along seams | Low–Med (maintainability) | Medium (churn) | Optional, when touching that area |
| F | RLS backstop on GPS tables + test | Low (latent security) | Low | Do soon |
| G | Shared frontend package | Negative | Med | **Reject** — adds coupling for little gain |

---

## Production-readiness score

| Dimension | Score | Rationale |
|---|---:|---|
| Architecture | **89** | Clean modular separation, multi-tenant + API-first from day one; the one large service (jobs) is a cohesive Job-aggregate root — kept together by design, not left as debt. |
| Security | **91** | RLS + granular perms + parameterized SQL + no secrets + signed webhooks + request-id tracing; GPS isolation has a compensating-control test. |
| Performance | **90** | N+1 write loops removed (set-based), six composite indexes, message thread bounded, FleetHQ route + vendor code-splitting. A seeded 12k-row scale test proves the hot report stays index-backed (EXPLAIN, no Seq Scan) and <2s. |
| Maintainability | **89** | Strict types, consistent patterns, strong docs, permission-parity CI guard, generated API reference; the deliberate two-frontend duplication is guarded, not drifting. |
| Scalability | **88** | Stateless API + RLS + opt-in scheduler + index-verified reporting at scale; read-model/caching + a true concurrent load test for the very largest tenants are the remaining frontier. |
| Testing | **88** | 277 API e2e (incl. tenant isolation, GPS isolation, scale/index proof) + growing FleetHQ integration/unit coverage (signup, trial banner, quick-fill). |
| **Overall** | **~89 / 100** | Investable and enterprise-capable; the remaining points need real production signal (concurrent load, first enterprise customers, SSO/audit-export), not more code. |

*(Trajectory: ~84 baseline → ~86 after the "next 10" hardening → ~89 after the scale + quality pass. See "Honest ceiling" below.)*

### Honest ceiling

Getting materially past ~90 is **not** a code exercise — it needs signal only real operation produces, and claiming higher would be dishonest:
- **Concurrent load at true scale** (many tenants, high RPS) on production-grade RDS — the scale test here proves index behaviour on one large tenant, not contention/connection-pool/replica behaviour.
- **Enterprise auth & governance** — SSO/SAML/SCIM, audit-log export, data-residency controls, and a formal security posture (pen test, SOC 2-style controls).
- **Operational maturity** — real dashboards/alerts wired to live traffic, on-call runbooks, and incidents actually handled.
- **Battle-testing** — weeks of real customer usage surfacing the edge cases no audit predicts.

Those are the honest path from ~89 to the mid-90s. The codebase is ready to earn them.

---

## Next 10 engineering priorities

1. **Pagination hardening** — default caps + cursor pagination on `Job`, `JobStop`, `TimelineEvent`, `Notification`, `ChecklistSubmission`, `Message`; add a lint/test forbidding unbounded `findMany` on those models.
2. **Route-level code-splitting** in FleetHQ (`React.lazy` + `Suspense`) to cut the ~1.3 MB first-load chunk.
3. **Permission-catalog parity CI check** — fail the build if `api` and `fleethq` catalogs drift (the one deliberate duplication).
4. **Scheduled-jobs runner** — automate the notification digest, trial-expiry transitions, and compliance-expiry alerts (`@nestjs/schedule` or external cron).
5. **Observability depth** — end-to-end request/trace IDs, p95-latency + error-rate dashboards and alerts (Sentry already wired).
6. **Composite indexes** guided by a load test at 10k+ jobs / 100k+ stops per tenant; validate the planner's choices.
7. **RLS backstop (or documented compensating control + test)** on the GPS tables.
8. **Frontend integration tests** for the critical flows (dispatch create/assign/complete, POD capture) and the offline sync engine.
9. **Engineering README** — setup, architecture-at-a-glance, folder map, dev workflow, coding standards — for a cold-start engineer.
10. **Publish the OpenAPI spec** and a versioning/deprecation policy to fully honour the "API-first, third-party-integrable" promise.

---

*This report is a point-in-time snapshot (2026-07). Update it, and the CHANGELOG, as the priorities above are worked.*
