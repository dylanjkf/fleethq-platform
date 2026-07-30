# FleetOS API

The single versioned API every FleetOS client — FleetHQ, DriverOS, or a future
third-party integration — reads and writes through. See
[`FleetOS-Playbook/12-API/API_Architecture.md`](../../FleetOS-Playbook/12-API/API_Architecture.md)
for the contract this is built against, and
[`FleetOS-Playbook/CLAUDE.md`](../../FleetOS-Playbook/CLAUDE.md) for the
operating principles (offline-first, API-first, granular permissions,
Asset/Operator/Attached Unit terminology) this codebase is expected to hold to.

Two milestones in so far: the **foundation slice** (project scaffold, core
data model, Asset + Operator registries) and the **Administration API**
(self-service company signup, user invite/role-change/deactivate, role
CRUD/clone/archive), followed by an **enterprise-readiness review**
(health checks, structured logging, graceful shutdown, and a few other
day-one-cheap changes — see
[`Scaling_And_Enterprise_Readiness.md`](../../FleetOS-Playbook/02-Architecture/Scaling_And_Enterprise_Readiness.md)
for the full tiered plan, including what's deliberately *not* built yet and
why). See `CHANGELOG.md` at the repo root for what's deliberately out of
scope so far, and for several real RLS bugs found and fixed while verifying
each milestone end-to-end against a real Postgres instance — worth reading
before adding a new RLS policy in this codebase.

## Prerequisites

- Node.js 20+ (built and tested against 22)
- Docker (for local Postgres via `docker-compose`)

## First-time setup

```bash
# from the repo root
docker compose up -d

cd apps/api
cp .env.example .env
npm install                    # also runs `prisma generate` via postinstall
npm run prisma:migrate:deploy  # creates the schema, RLS policies, and the
                                # low-privilege fleetos_app/fleetos_auth roles
npm run seed                   # bootstraps two demo companies + admin users —
                                # optional now that POST /v1/companies exists,
                                # but still the fastest way to get local data
npm run dev
```

The seed script prints the username/password for each demo company's admin
user. Log in with:

```bash
curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin@acme","password":"fleetos-dev-password"}'
```

then call any endpoint with `Authorization: Bearer <accessToken>`. Or skip the
seed script entirely and sign up a brand-new company yourself:

```bash
curl -s -X POST http://localhost:3000/v1/companies \
  -H 'Content-Type: application/json' \
  -d '{"companyName":"My Test Co","adminUsername":"me","adminPassword":"a-strong-password","adminFullName":"Me"}'
```

which logs you straight in as that company's Administrator — no separate
login call needed.

## Why there are three database roles

`DATABASE_URL` (schema owner) is what `prisma migrate` and the seed script
use. `APP_DATABASE_URL` (`fleetos_app`, no `BYPASSRLS`) is what the running
API actually connects as for everything tenant-scoped. This is deliberate,
not incidental: multi-tenancy in this codebase is enforced by Postgres
row-level security, not just a `WHERE company_id = ...` the application layer
has to remember to add. If the app connected as the owning role, RLS would
silently not apply.

`AUTH_DATABASE_URL` (`fleetos_auth`) is a third, even narrower role: BYPASSRLS,
but granted `SELECT` on the `users` table and nothing else at all. It exists
for exactly one call site — AuthService's "find the user with this username"
lookup at login, which runs before any tenant context exists and structurally
can't be scoped by the usual RLS mechanism (see
`src/prisma/system-prisma.service.ts`).

Several migrations are worth reading before adding a new RLS policy in this
codebase — each one is a real bug found by actually running the tests against
Postgres, not by inspection:
- `20260713072000_fix_rls_stale_session_guc` — a touched-then-reset session
  GUC reads back as `''`, not `NULL`; every policy reads GUCs through
  `NULLIF(current_setting(...), '')::uuid` because of this.
- `20260713080000_admin_entities_and_users_rls` and
  `20260713081500_fix_users_rls_visible_when_archived` — `INSERT ...
  RETURNING` (what Prisma's `.create()`/`.update()` always does) re-checks
  SELECT visibility on the row being returned, which bit both "create a user
  before their membership exists" and "archive a user's last membership and
  try to read them back in the same response."

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the API with hot reload |
| `npm run build` | Production build (`dist/`) |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm test` | Unit tests + integration tests (needs Postgres running) |
| `npm run prisma:migrate:dev` | Create a new migration from schema changes |
| `npm run prisma:migrate:deploy` | Apply pending migrations (what CI/prod use) |
| `npm run seed` | Bootstrap local dev data |
| `npm run permissions:sync` | Grant any catalog permission added since a company was created to its Administrator/Read Only system-template roles — run after any deploy that adds a permission (`npm run seed` already does this for local dev) |

## Observability

- `GET /health` — liveness (process up, no dependency checks). `GET /health/ready`
  — readiness (checks Postgres). Both live outside `/v1/` on purpose — they're
  infra endpoints a load balancer/orchestrator checks, not the business API.
- Every request is logged as structured JSON (`nestjs-pino`); `Authorization`
  headers are redacted. Login attempts (success/failure/reason) and
  permission-denied rejections are logged as distinct structured events
  (`event: "auth.login_failed"`, `"auth.login_succeeded"`,
  `"access.permission_denied"`) — this is the security/access audit trail,
  deliberately separate from `TimelineEvent` (business-entity history).
  Logging is silenced automatically under `NODE_ENV=test` so `npm test`
  output stays readable.
