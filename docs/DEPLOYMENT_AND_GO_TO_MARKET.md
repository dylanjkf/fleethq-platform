# FleetOS — founder deployment & go-to-market checklist

Everything **you** have to do to take FleetOS from "green in CI" to "running in
production and being sold." The application code is done and tested; the remaining
items require your hosting accounts, your money, your domain, your legal sign-off,
and — for the compliance claims — an external auditor.

> **Reality check on infrastructure.** There is **no Terraform / infrastructure-
> as-code in this repository**, and no AWS stack is provisioned by it. The real,
> supported deployment path is **managed platforms**: the **API on Railway**, the
> **frontends on Vercel**, and **DriverOS as a PWA / app-store build**. The
> AWS/ECS/RDS/CloudFront topology that older drafts of this doc described is a
> *planned target architecture*, not something you `terraform apply`. Follow the
> Railway path below; it is what actually exists. The canonical reference is the
> repo-root [`README.md`](../README.md) → **Deployment**.

Work top to bottom. Each phase gates the next. Times are rough.

---

## Where the code stands (done — no action from you)

- Application CI is green: the API test suite runs on a real Postgres via
  `.github/workflows/api-ci.yml` (lint, typecheck, migrations, seed, build, Jest).
- A scheduled **restore drill** (`.github/workflows/restore-drill.yml`) round-trips
  the database dump/restore weekly, so a schema/restore regression fails CI.
- **Dependabot** (`.github/dependabot.yml`) watches the API's npm dependencies and
  the GitHub Actions toolchain.
- Dependencies are clean of known high/critical vulnerabilities in production
  packages (verified by the `npm audit` step you can run in `api/`).
- The frontends and DriverOS build and deploy from **their own repositories** —
  see each repo's README.

> Not yet done, and not blocking a pilot: no IaC, no WAF, no managed
> monitoring/alerting, no multi-AZ/cross-region database. These are the
> infrastructure-layer items tracked as **Planned** in `docs/compliance/` and
> `docs/security/cyber-essentials/`.

---

## Phase 1 — Stand up the API on Railway (½ day)

> Reference: repo-root `README.md` → **Deployment → API → Railway**, and
> `api/.env.example` for every variable with its rationale.

1. **Create a Railway project** and add the **Postgres plugin** (this is your
   managed database). Railway's Postgres provides the `DATABASE_URL`.
2. **Add a service pointing at this repo with Root Directory = `api/`.** Railway
   picks up `api/railway.json` (Dockerfile builder) automatically. On every deploy,
   `api/docker-entrypoint.sh` runs `prisma migrate deploy` *before* the server
   starts — the migrations create the schema, the RLS policies, and the
   `fleetos`/`fleetos_app`/`fleetos_auth`/`fleetos_admin` roles. There is no
   separate release step to trigger by hand.
3. **Set the environment variables** in Railway's **Variables** tab (see the table
   in the repo `README.md`; full detail in `api/.env.example`). At minimum:
   `DATABASE_URL` (schema-owner, from the Postgres plugin), `APP_DATABASE_URL`,
   `AUTH_DATABASE_URL`, `ADMIN_DATABASE_URL` (the low-privilege runtime roles),
   `JWT_SECRET` and a *different* `ADMIN_JWT_SECRET` (each 32+ random chars in
   production — the API refuses to boot if they are equal, weak, or the in-repo
   placeholder), `INTEGRATION_CREDENTIAL_KEY`, `CORS_ALLOWED_ORIGINS`, and
   `APP_BASE_URL`.
4. **Set the runtime role passwords to match** `APP_DATABASE_URL` /
   `AUTH_DATABASE_URL` / `ADMIN_DATABASE_URL`. A fresh Railway Postgres only has
   the master role; run `npm run db:rotate-role-passwords` in `api/` against the
   deployed database (or `ALTER ROLE ... PASSWORD ...` directly). The API's
   fail-fast env validation will **refuse to boot** in production if a connection
   string still carries a known dev-only password, so this step cannot be silently
   skipped.
5. **Bootstrap the first FleetHQ staff account:** set `BOOTSTRAP_STAFF_ADMIN=true`
   + `BOOTSTRAP_STAFF_ADMIN_USERNAME/PASSWORD/EMAIL/FULL_NAME` in the deployed
   environment and redeploy — `prod-bootstrap` creates the account on boot
   (created `mustResetPassword`, and with `ENFORCE_STAFF_ADMIN_MFA` on it must
   enroll MFA on first sign-in). **Do not run `npm run admin:bootstrap` against
   production** — that `ts-node` script isn't in the runtime image and can't run
   in the container; it's for local dev. Remove the flag + password from the env
   once the account exists (`api/.env.example` has the full block + warning).
6. **Smoke-test the API**: hit `GET /health` (liveness) and `GET /health/ready`
   (readiness — checks Postgres connectivity), then log in and click through a real
   courier workflow.

---

## Phase 2 — Deploy the frontends on Vercel (2–3 hours)

The office dashboard SPA (and the `admin/` console) live in the **`fleethq-frontend`**
repo and deploy to **Vercel**; DriverOS lives in **`fleethq-driveros`**.

1. **Import `fleethq-frontend` into Vercel** and configure its build and rewrites
   per that repo's own README (it builds `admin/` separately into `dist/admin/`).
   Point its API base at your Railway API URL.
2. **Set `CORS_ALLOWED_ORIGINS`** on the Railway API to include the deployed
   frontend origin(s) — one entry (e.g. `https://fleethq.online`) covers both the
   office dashboard and `/admin`, since they share an origin.
3. **DriverOS** is installable as a PWA today with zero store review; for native
   App Store / Google Play builds follow `fleethq-driveros`'s "Native app
   packaging" section (needs a human with Xcode / Android Studio / developer
   accounts — none of that can happen in CI).

---

## Phase 3 — Domain, TLS & the fail-fast secrets (1–2 hours)

1. **Add your domain** to the Railway API service and to the Vercel frontend
   project (each platform issues and renews TLS certificates automatically — TLS
   termination is a managed-platform feature, not something you provision). Set
   `APP_BASE_URL` (Railway) and the frontend's API base to the final URLs so
   emailed verification/reset/invite links are correct.
2. **Confirm the strong secrets are set** (`JWT_SECRET` ≥ 32 random chars, a
   distinct `ADMIN_JWT_SECRET`). The API **refuses to boot** in production with a
   placeholder or weak secret — this is deliberate. The same fail-fast rejects any
   dev-default DB password that survived, so confirm the Phase 1 role-password step
   took.

---

## Phase 4 — Turn on the paid/external integrations (as you need them)

Each of these is a **founder-provided value set as an environment variable** in
Railway (not a Terraform tfvar). Each is **off by default** and the app degrades
gracefully until you set it — so none blocks a pilot, but each is required before
the corresponding feature is real.

| Feature | What you do | Env vars (Railway Variables) |
|---|---|---|
| **Outbound email** (verify/reset/invite, digests) | Verify a From address with your email provider (e.g. **AWS SES** in ap-southeast-2, out of sandbox) | `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `AWS_REGION` (+ the provider's credentials) |
| **Attachment storage in S3** (POD/fault photos) | Create a bucket; set it before real photo volume (inline-in-Postgres is fine for a pilot) | `ATTACHMENTS_BUCKET` (+ AWS credentials) |
| **Billing (Stripe)** | Create a Stripe account, create live-mode Prices, add the keys | `STRIPE_*`, `BILLING_ENFORCED=true` once tested, the three `STRIPE_PRICE_*` ids |
| **Error tracking (Sentry)** | Create a Sentry project | `SENTRY_DSN` |
| **Web push** | Generate VAPID keys (`npx web-push generate-vapid-keys`) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |

---

## Phase 5 — Prove it before customers depend on it (1–2 days)

- [ ] **Restore drill against the live database.** The scheduled
      `.github/workflows/restore-drill.yml` already proves the dump/restore script
      round-trips a seeded database in CI. What it does **not** prove is production
      RPO/RTO: do a timed restore of the real Railway (or AWS) database into a
      throwaway database and record the actual numbers. This is the one DR item
      that cannot be proven from code — it needs the live environment.
- [ ] **End-to-end smoke test on production**: create a company, invite an
      operator, run a multi-stop job on a real tablet through DriverOS, capture
      POD, confirm it appears in FleetHQ and the receipt PDF renders.
- [ ] **Load check** against a staging Railway environment with the bundled load
      tool (`api/scripts/load-test.ts`) at your expected fleet size.
- [ ] **Independent penetration test.** Engage a firm (scope: cross-tenant access
      first — RFP in `docs/compliance/audit-engagement.md`). Required before selling
      to security-conscious buyers, and an ISO A.5.35 control.

---

## Phase 6 — Security & compliance to close before you *sell* (parallel, weeks)

These don't block a friendly pilot, but a security-conscious enterprise buyer will
ask for them. Most are organisational, not code:

- [ ] **Enable branch protection** on `main` (require a PR + approving review + the
      `api-ci` / `restore-drill` status checks). Note: there is **no CODEOWNERS file
      committed yet** — add one if you want required code-owner review, then include
      it in the ruleset. (Earlier drafts claimed CODEOWNERS was already committed;
      it is not.)
- [ ] **Build the infrastructure-layer controls** (or accept the managed-platform
      posture explicitly). Network segmentation, WAF, KMS-at-rest, managed
      monitoring/alerting, and multi-AZ/cross-region database are documented as
      **Planned target architecture** — none exists in this repo today.
- [ ] **Assign named owners** to every ISMS role and **sign the policies** —
      replace every *TBD* in `docs/compliance/` (governance-execution.md is the
      fill-in register).
- [ ] **Schedule the quarterly management review**; keep the risk register live.
- [ ] **Execute DPAs** with your sub-processors — Railway and Vercel (hosting),
      plus Stripe / your email provider / Sentry as you enable them (sub-processor
      register in governance-execution.md).
- [ ] **HR controls**: onboarding security training, NDAs, offboarding checklist.
- [ ] **Engage an ISO 27001 body / SOC 2 CPA firm** and run the SOC 2 **Type II
      observation period** (3–12 months). Your audit log + CI history are the
      evidence base. Runbooks in `docs/compliance/audit-engagement.md`.

> **Honest representation (important):** until an external report exists, do
> **not** tell customers FleetOS "is ISO 27001 certified" or "is SOC 2 compliant,"
> and do not represent infrastructure-layer controls that are not yet built (WAF,
> KMS-at-rest, multi-AZ DR) as if they were in force. You *can* accurately say
> FleetOS is **built to** ISO 27001 / SOC 2 controls at the application layer and
> is **pursuing certification**, and share this documentation and a SOC 2 Type I /
> bridge letter once obtained. Overclaiming here — especially claiming controls
> that no file in the repo implements — is the fastest way to fail a procurement
> security review.

---

## Phase 7 — Start selling

- [ ] **Publish the legal docs** (ToS, Privacy Policy, DPA drafts exist in the
      Playbook `20-Legal/` / `14-Security/` — have a lawyer review, then host them
      and link from signup).
- [ ] **Appoint a Privacy Officer** (Australian Privacy Act / NDB) — the breach
      procedure is in the incident-response doc.
- [ ] **Turn on billing** (Phase 4) with live Stripe pricing, set
      `BILLING_ENFORCED=true`.
- [ ] **Onboard your first pilot** — with real data, on the domain, with email + S3
      on. Use their feedback to prioritise.
- [ ] **Sell to the next ones** with: a working product, this documentation set, a
      completed pentest, and "pursuing ISO 27001 / SOC 2" — then convert to
      "certified" once the external reports land.

---

### The shortest honest path to a first paying pilot
Phase 1 (API on Railway) → Phase 2 (frontends on Vercel) → Phase 3 (domain + JWT
secrets) → Phase 4 email + S3 → Phase 5 restore drill + smoke test. That's a
deployable, sellable-to-a-friendly-first-customer product. Phases 6–7 (build the
infra controls, pentest, signed policies, certification, published legal, live
billing) run in parallel and are what open up security-conscious enterprise buyers.
