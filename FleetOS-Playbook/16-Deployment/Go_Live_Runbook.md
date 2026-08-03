# Go-Live Runbook (A1)

The end-to-end sequence to take FleetOS from "green in CI" to a live,
internet-reachable, smoke-tested production environment — the A1 workstream of
`17-Roadmap/Launch_Readiness_Plan.md`. Everything the *application code* can do is
done and committed; what remains is execution against real hosting and third-party
accounts, which only the founder can provide.

> **The real deployment path is managed platforms — there is no Terraform/IaC in
> this repository.** The API deploys to **Railway** (managed Postgres plugin +
> Dockerfile service rooted at `api/`), the frontends deploy to **Vercel**, and
> DriverOS ships as a PWA / app-store build from its own repo. The canonical
> reference is the repo-root [`README.md`](../../README.md) → **Deployment**. The
> AWS/ECS/RDS/CloudFront/OIDC path that older drafts of this runbook described is a
> *planned target architecture*, not something you provision today.

This runbook ties together what is actually in the repo:
- Repo-root `README.md` → **Deployment** — the Railway/Vercel/DriverOS steps.
- `api/railway.json` + `api/docker-entrypoint.sh` — the Railway build and the
  automatic `prisma migrate deploy` on every deploy.
- `api/.env.example` — every runtime environment variable with its rationale.
- `.github/workflows/api-ci.yml` — the CI gate (lint, typecheck, migrations, seed,
  build, tests) and `.github/workflows/restore-drill.yml` — the scheduled
  dump/restore drill.

Follow it top to bottom. **Do a staging Railway environment first, always**; only
touch production once staging has passed the smoke test.

---

## 0. What you must provide (nobody else can)
- A **Railway account** (hosts the API and its managed Postgres) and a **Vercel
  account** (hosts the frontends). Billing set up on each.
- A **domain name** (optional for the first deploy — Railway/Vercel give you
  default URLs until you wire one).
- Real third-party accounts, each of which becomes an **environment variable in
  Railway** (not a Secrets Manager entry): **Sentry** (`SENTRY_DSN`), **Stripe**
  (`STRIPE_*` + price ids), an **email provider** such as SES
  (`EMAIL_PROVIDER`/`EMAIL_FROM_ADDRESS`/`AWS_REGION`), and **VAPID** keys for web
  push (`npx web-push generate-vapid-keys`).
- A monitored **alert inbox** for Sentry/notifications.

## 1. Provision the API on Railway (staging first)
Follow the repo-root `README.md` → **Deployment → API → Railway**:
1. Create a Railway project and add the **Postgres plugin**.
2. Add a service pointing at this repo with **Root Directory = `api/`** — Railway
   uses `api/railway.json` (Dockerfile builder). Every deploy runs
   `prisma migrate deploy` automatically before the server starts (via
   `api/docker-entrypoint.sh`), which creates the schema, RLS policies, and the
   `fleetos`/`fleetos_app`/`fleetos_auth`/`fleetos_admin` roles.
3. Set the environment variables (§5) in the **Variables** tab.

There is no infra bootstrap, no remote state, and nothing to `terraform apply` —
the schema and roles are created by the migrations themselves.

## 2. Set the runtime role passwords (one-time per database)
A fresh Railway Postgres only has the master role. Point `DATABASE_URL` at it, let
the first deploy run the migrations (which create the `fleetos_app`/`fleetos_auth`/
`fleetos_admin` roles), then set those roles' passwords to match
`APP_DATABASE_URL`/`AUTH_DATABASE_URL`/`ADMIN_DATABASE_URL`:

- `npm run db:rotate-role-passwords` in `api/`, run against the deployed database,
  **or** `ALTER ROLE ... PASSWORD ...` directly.

The API's fail-fast env validation **refuses to boot** in production if a
connection string still contains a known dev-only role password, so this step
cannot be silently skipped.

## 3. Deploy the frontends on Vercel
The office dashboard SPA (with the `admin/` console) is in **`fleethq-frontend`**;
deploy it to Vercel per that repo's README (it builds `admin/` separately into
`dist/admin/`). Point its API base at the Railway API URL, and add the frontend
origin to `CORS_ALLOWED_ORIGINS` on the API.

## 4. First deploy (staging), then smoke test
1. Trigger a Railway deploy of the API service (a push to the connected branch, or
   a manual redeploy). Railway builds the image, runs `prisma migrate deploy`
   automatically, and starts the server.
2. Deploy `fleethq-frontend` to Vercel (staging).
3. Bootstrap the first FleetHQ staff account by setting `BOOTSTRAP_STAFF_ADMIN=true`
   + `BOOTSTRAP_STAFF_ADMIN_USERNAME/PASSWORD/EMAIL/FULL_NAME` in Railway and
   redeploying — `prod-bootstrap` creates it on boot (mustResetPassword + forced
   MFA on first sign-in). **Do not run `npm run admin:bootstrap` against production**
   — it's `ts-node` and isn't in the runtime image, so it can't run in the
   container (local dev only). Remove the flag + password from the env once the
   account exists. See `api/.env.example`.
4. **Smoke test** the deployed staging URLs (`GET /health/ready` first):
   - Sign up a company → **verify the email link works** (requires §5 email) → log
     in.
   - Create an asset + operator; create a job; add a stop; on DriverOS complete the
     stop with a photo/signature; **download the POD receipt** from FleetHQ.
   - Confirm the dispatch board and reports render.
   - Trigger **forgot-password** and complete a reset.

## 5. Turn on the real integrations (set the env vars)
The API runs with these **unset** by default and degrades gracefully. Set them as
**Railway Variables**, then redeploy so the new process picks them up (see
`api/.env.example` for the full list and rationale):

- **Email** (verification/reset/invite + notifications): set `EMAIL_PROVIDER`,
  `EMAIL_FROM_ADDRESS`, `AWS_REGION` (and the provider credentials). Verify the
  From address with your provider first (e.g. SES out of sandbox). Ensure
  `APP_BASE_URL` is the final URL so links are correct.
- **Web push**: set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.
- **Sentry**: set `SENTRY_DSN`.
- **Stripe billing** (A3): set `STRIPE_*` and the live `STRIPE_PRICE_*` ids; create
  the webhook endpoint at `https://<api>/v1/billing/webhook`. Leave
  `BILLING_ENFORCED` unset/false until you've tested the full subscribe→active flow
  with a real card, then set it `true` to enforce plan limits.
- **Attachment storage** (optional): set `ATTACHMENTS_BUCKET` (+ AWS credentials) —
  inline-in-Postgres is fine for a pilot.

## 6. Add the domain (optional but expected before selling)
Add your domain to the Railway API service and the Vercel frontend project. Each
platform issues and renews TLS certificates automatically (managed TLS
termination). Update `APP_BASE_URL` and the frontend's API base to the final URLs.

## 7. Production
Repeat §1–§5 against a production Railway environment (a separate Railway project
or environment with its own Postgres). Then run the **A4 restore drill against the
live production database** and a **load test** (`api/scripts/load-test.ts`), per
`14-Security/Production_Operations.md`. The scheduled `restore-drill.yml` already
proves the dump/restore *script* round-trips in CI; the live-database timed restore
(actual RPO/RTO) still has to be done by hand in the real environment.

## Rollback
- **Bad code deploy:** Railway keeps the previous deploy — roll back to it in the
  Railway dashboard (or redeploy the previous good commit).
- **Migrations are forward-only** — a rollback restores the previous *image*, not
  the schema. Schema changes must stay backward-compatible across one deploy
  (expand/contract); a destructive schema change that has to be undone needs a
  point-in-time restore of the managed database (see the backup/DR doc), which is
  why the A4 restore drill exists.

## Status of this workstream
- Code/config: **done** — the API builds and deploys on Railway with automatic
  migrations; the CI gate and the scheduled restore drill are wired; the runtime
  env contract is documented in `api/.env.example`.
- Not built (Planned): the AWS infrastructure-layer controls (IaC, WAF, KMS-at-rest,
  managed monitoring, multi-AZ/cross-region DB). These do not block go-live on the
  managed-platform path.
- Execution: **blocked on the founder** providing the Railway/Vercel accounts, the
  domain, and the third-party accounts in §0. Nothing else stands between here and a
  live environment.
