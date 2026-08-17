# FleetHQ Platform

The FleetOS API and the full product specification (`FleetOS-Playbook/`).
FleetOS is split across three repos:

- **This repo (`fleethq-platform`)** — the API only.
- [`fleethq-frontend`](https://github.com/dylanjkf/fleethq-frontend) — the
  customer office dashboard SPA, plus `admin/`, the FleetHQ staff console
  (a separate app within that repo, deployed alongside it at
  `fleethq.online/admin`).
- [`fleethq-driveros`](https://github.com/dylanjkf/fleethq-driveros) — the
  driver/field mobile app, its own repo so native iOS/Android builds and
  app-store release tooling aren't coupled to the API's release cadence.

```
api/                the API — NestJS + Prisma + PostgreSQL, multi-tenant with row-level security
FleetOS-Playbook/    the product specification — read its CLAUDE.md first
docs/                architecture/security/database/deployment reference docs
```

Every client — `fleethq-frontend`, `admin/`, `fleethq-driveros`, or a
third-party integration — reads and writes FleetOS data exclusively through
`api/`'s versioned REST API over HTTPS. No client gets direct database
access, a shared filesystem, or a local import of anything under `api/`.

The FleetHQ admin platform (`api/src/admin-*`, `admin_*` database tables,
`fleetos_admin` role) is FleetHQ staff's own tool for operating the SaaS
business (organisations, billing, support, system health) — completely
separate authentication and database role from the customer-facing product,
even though its frontend now shares a repo/deploy domain with
`fleethq-frontend`. See `FleetOS-Playbook/21-Admin-Platform/Overview.md`.

## Local development

```bash
docker compose up -d          # Postgres 16 on localhost:5432

cd api
cp .env.example .env          # see api/README.md / .env.example for details
npm install
npm run prisma:migrate:deploy # creates the schema, RLS policies, and the fleetos_app/fleetos_auth/fleetos_admin roles
npm run seed
npm run dev:watch             # http://localhost:3000
```

`fleethq-frontend` (its own repo, `admin/` included) and `fleethq-driveros`
(its own repo) both point at this same local API — set `VITE_API_URL`/
`VITE_API_BASE` unset (each app's own dev server proxies `/v1` and `/health`
to `localhost:3000`) or run them side by side against
`http://localhost:3000`. To exercise `admin/` locally you'll also need a
bootstrapped `AdminUser`: `npm run admin:bootstrap` in `api/` (see
`api/scripts/bootstrap-admin.ts`).

## Deployment

### API → Railway

1. Create a Railway project, add a Postgres plugin, and add a service
   pointing at this repo with **Root Directory set to `api/`** — Railway
   picks up `api/railway.json` (Dockerfile builder) automatically.
2. Set the environment variables below in Railway's Variables tab.
3. Every deploy runs `prisma migrate deploy` automatically before the server
   starts (`api/docker-entrypoint.sh`) — no separate release step to trigger
   by hand. This is gated by `RUN_MIGRATIONS_ON_BOOT` (default `true`). **If
   you scale the API past a single replica, set `RUN_MIGRATIONS_ON_BOOT=false`**
   and run `prisma migrate deploy` once as a dedicated pre-deploy step instead
   — otherwise several replicas racing the same migration on boot can conflict.
   At one replica (the default) leave it unset.
4. It also runs `api/src/bootstrap/prod-bootstrap.ts` after migrations to seed
   the permission catalog and (optionally) create the first accounts. This is
   **fatal on a genuinely-broken bootstrap** (empty catalog, no admin created):
   the container refuses to start rather than serving a half-initialised
   platform, so `/health/ready` going green means bootstrap succeeded.
5. **Auto-deploy on merge, gated on CI:** `.github/workflows/deploy-api.yml`
   deploys the API to Railway, but only **after `api-ci.yml` passes on the same
   commit** (it triggers on `api-ci` completion via `workflow_run` and checks
   out the exact validated SHA) — a commit whose lint/tests failed can't reach
   production. It needs a `RAILWAY_TOKEN` **secret** (a Railway project/account
   token) and a `RAILWAY_SERVICE` **variable** (the API service's name) in the
   repo settings; without both the job stops early with a clear message. Enable
   "Require status checks (api-ci)" + "Require review from Code Owners" (see
   `.github/CODEOWNERS`) branch protection on `main` for the full gate. This
   replaces relying on Railway's own GitHub auto-deploy — disable one if you
   enable the other to avoid double deploys.

**Required environment variables** (see `api/.env.example` for the full
list with rationale):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Schema-owner connection (migrations) |
| `APP_DATABASE_URL` | Low-privilege runtime connection (RLS-enforced) |
| `AUTH_DATABASE_URL` | Pre-tenant-context login lookup (narrow SELECT-only role) |
| `ADMIN_DATABASE_URL` | The FleetHQ admin platform's runtime connection (`fleetos_admin`, `BYPASSRLS` with narrow explicit grants — see `FleetOS-Playbook/21-Admin-Platform/Overview.md`) |
| `JWT_SECRET` | Customer session token signing — 32+ random chars in production |
| `ADMIN_JWT_SECRET` | Admin session token signing — a completely different secret from `JWT_SECRET`; boot fails if they're ever equal |
| `INTEGRATION_CREDENTIAL_KEY` | AES-256 key for the Integration Hub credential vault |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed frontend origins, e.g. `https://fleethq.online` — one entry covers both the office dashboard and `/admin`, since they share an origin |
| `APP_BASE_URL` | Deployed FleetHQ URL, used in emailed links |

Optional (safe no-op when unset): `VAPID_*` (web push), `SENTRY_DSN` (error
tracking), `STRIPE_*`/`BILLING_ENFORCED` (billing), `EMAIL_PROVIDER`/
`EMAIL_FROM_ADDRESS`/`AWS_REGION` (SES email), `ATTACHMENTS_BUCKET` (S3
attachment storage — inline-in-Postgres otherwise).

The database roles (`fleetos`, `fleetos_app`, `fleetos_auth`, `fleetos_admin`)
and their RLS policies are created by the migrations themselves — a fresh
Railway Postgres just needs `DATABASE_URL` pointed at it and
`prisma migrate deploy` run once (handled automatically, see above); the
role passwords still need to be set to match `APP_DATABASE_URL`/
`AUTH_DATABASE_URL`/`ADMIN_DATABASE_URL` (`npm run db:rotate-role-passwords`
in `api/`, or set them directly via `ALTER ROLE ... PASSWORD ...` against
the new database).

To create the first FleetHQ **staff** account (the `/admin` console) on the
deployed API, set `BOOTSTRAP_STAFF_ADMIN=true` plus
`BOOTSTRAP_STAFF_ADMIN_USERNAME/PASSWORD/EMAIL/FULL_NAME` in Railway and
redeploy — `prod-bootstrap` creates it on boot. **Do NOT use
`npm run admin:bootstrap` against production**: that script is `ts-node` and is
not included in the runtime image (`npm ci --omit=dev`, `dist/` only), so it
cannot run in the container — it exists for local dev only. The bootstrap
account is created `mustResetPassword=true` so the temporary password must be
changed on first sign-in. Staff MFA is required by default (fail closed) — the
console blocks an un-enrolled admin until they enrol, and this cannot be turned
off in production; `ENFORCE_STAFF_ADMIN_MFA=false` opts out only outside prod.
**Remove `BOOTSTRAP_STAFF_ADMIN` and its password from the env once the account
exists.** See `api/.env.example` for the full block.

### fleethq-frontend (+ admin/) → Vercel

Deploys from its own repo — see `fleethq-frontend`'s own README for the
multi-app build (`admin/` builds separately and is stitched into
`dist/admin/`) and Vercel rewrite configuration.

### fleethq-driveros → app stores + PWA

DriverOS is installable as a PWA today with zero store review. For the
native App Store / Google Play builds, the Capacitor toolchain and native
`ios/`/`android/` projects already exist in that repo — see its own README's
"Native app packaging" section for what's done and what still needs a human
with Xcode/Android Studio/developer accounts (none of that can happen in
CI).

## FleetOS-Playbook

The full product specification — company vision, terminology, the
permissions model, Australian compliance rules, and per-feature specs.
**Read `FleetOS-Playbook/CLAUDE.md` before making any product decision.**
