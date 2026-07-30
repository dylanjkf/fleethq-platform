# FleetHQ Platform

The FleetOS API, the DriverOS mobile app, and the full product specification
(`FleetOS-Playbook/`). Together with
[`fleethq-frontend`](https://github.com/dylanjkf/fleethq-frontend) (the
office dashboard SPA), this is FleetOS.

```
api/                the API — NestJS + Prisma + PostgreSQL, multi-tenant with row-level security
driveros/            the driver/field app — React + Vite PWA, wrapped natively with Capacitor
FleetOS-Playbook/    the product specification — read its CLAUDE.md first
docs/                architecture/security/database/deployment reference docs
```

Each of `api/` and `driveros/` is independently built, tested, and deployed —
see their own READMEs for day-to-day development. This file covers running
them together locally and deploying them to production.

## Local development

```bash
docker compose up -d          # Postgres 16 on localhost:5432

cd api
cp .env.example .env          # see api/README.md / .env.example for details
npm install
npm run prisma:migrate:deploy # creates the schema, RLS policies, and the fleetos_app/fleetos_auth roles
npm run seed
npm run dev:watch             # http://localhost:3000

# in another terminal
cd driveros
npm install
npm run dev                   # http://localhost:5173, proxies /v1 and /health to :3000
```

`fleethq-frontend` (a separate repo) can point at this same local API by
setting `VITE_API_URL` unset (its own dev server proxies the same way) or by
running it side by side against `http://localhost:3000`.

## Deployment

### API → Railway

1. Create a Railway project, add a Postgres plugin, and add a service
   pointing at this repo with **Root Directory set to `api/`** — Railway
   picks up `api/railway.json` (Dockerfile builder) automatically.
2. Set the environment variables below in Railway's Variables tab.
3. Every deploy runs `prisma migrate deploy` automatically before the server
   starts (`api/docker-entrypoint.sh`) — no separate release step to
   trigger by hand.

**Required environment variables** (see `api/.env.example` for the full
list with rationale):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Schema-owner connection (migrations) |
| `APP_DATABASE_URL` | Low-privilege runtime connection (RLS-enforced) |
| `AUTH_DATABASE_URL` | Pre-tenant-context login lookup (narrow SELECT-only role) |
| `JWT_SECRET` | Session token signing — 32+ random chars in production |
| `INTEGRATION_CREDENTIAL_KEY` | AES-256 key for the Integration Hub credential vault |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed frontend origins, e.g. `https://app.fleethq.online` |
| `APP_BASE_URL` | Deployed FleetHQ URL, used in emailed links |

Optional (safe no-op when unset): `VAPID_*` (web push), `SENTRY_DSN` (error
tracking), `STRIPE_*`/`BILLING_ENFORCED` (billing), `EMAIL_PROVIDER`/
`EMAIL_FROM_ADDRESS`/`AWS_REGION` (SES email), `ATTACHMENTS_BUCKET` (S3
attachment storage — inline-in-Postgres otherwise).

The three database roles (`fleetos`, `fleetos_app`, `fleetos_auth`) and
their RLS policies are created by the migrations themselves — a fresh
Railway Postgres just needs `DATABASE_URL` pointed at it and
`prisma migrate deploy` run once (handled automatically, see above); the app
and auth role passwords still need to be set to match `APP_DATABASE_URL`/
`AUTH_DATABASE_URL` (`npm run db:rotate-role-passwords` in `api/`, or set
them directly via `ALTER ROLE ... PASSWORD ...` against the new database).

### DriverOS → app stores + PWA

DriverOS is installable as a PWA today with zero store review. For the
native App Store / Google Play builds, the Capacitor toolchain and native
`ios/`/`android/` projects already exist in this repo — see
`driveros/README.md` "Native app packaging" for what's done and what still
needs a human with Xcode/Android Studio/developer accounts (none of that can
happen in CI).

## FleetOS-Playbook

The full product specification — company vision, terminology, the
permissions model, Australian compliance rules, and per-feature specs.
**Read `FleetOS-Playbook/CLAUDE.md` before making any product decision.**
