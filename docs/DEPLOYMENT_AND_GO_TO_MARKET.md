# FleetOS — founder deployment & go-to-market checklist

Everything **you** have to do to take FleetOS from "green in CI" to "running in
production and being sold." The code and infrastructure-as-code are done; the
remaining items are the ones that require your AWS account, your money, your
domain, your legal sign-off, and — for the compliance claims — an external
auditor. Nothing here is code I can write for you; it's account setup,
credentials, and human decisions.

Work top to bottom. Each phase gates the next. Times are rough.

---

## Where the code stands (done — no action from you)

- All application CI is green: API (335 tests on real Postgres), both
  frontends (build + lint + test), Terraform (`validate` + tfsec), permission
  parity, secret scan (0 leaks across all history), CodeQL SAST (0 real alerts).
- Dependencies clean: no high/critical vulnerabilities in production packages.
- The Terraform builds the whole AWS stack (VPC, RDS, ECS, CloudFront, WAF,
  KMS, Secrets Manager, alarms). It has been **validated**, never **applied** —
  Phase 1 is where it first becomes real.

---

## Phase 1 — Stand up the infrastructure (½–1 day, ~A$150–400/mo running cost)

> Reference: `infra/README.md` and `infra/terraform/modules/api-service/README.md`.

1. **Create an AWS account** with billing set up. Everything below assumes you
   can create IAM roles in it. Region is **ap-southeast-2 (Sydney)** — already
   the default, for Australian data residency.
2. **Bootstrap Terraform state** (one time):
   ```
   cd infra/terraform/bootstrap
   terraform init
   terraform apply -var="bucket_name=fleetos-terraform-state-<unique>"
   ```
   Note the `bucket_name` and `lock_table_name` outputs.
3. **Backend + variables** for each environment:
   ```
   cd ../environments/base
   cp backend-staging.hcl.example backend-staging.hcl      # edit with step-2 names
   cp backend-production.hcl.example backend-production.hcl
   cp staging.tfvars.example staging.tfvars                 # set alert_email at minimum
   cp production.tfvars.example production.tfvars
   ```
   For the very first apply leave `manage_dns = false` and the
   `acm_certificate_arn_*` empty — you'll get default `*.cloudfront.net` / ALB
   DNS names until you wire a domain (Phase 3).
4. **Apply STAGING first — always:**
   ```
   terraform init -backend-config=backend-staging.hcl
   terraform apply -var-file=staging.tfvars
   ```
5. **Bootstrap the API on staging** (migrations, DB role-password rotation,
   first image) per `modules/api-service/README.md`, then **log in and click
   through a real courier workflow** before you touch production.
6. **Only then apply PRODUCTION:**
   ```
   terraform init -backend-config=backend-production.hcl
   terraform apply -var-file=production.tfvars
   ```

**Set `alert_email`** in both tfvars to a real, monitored inbox (ideally shared,
not one person) — the CloudWatch alarms and the security-event alerts go there.

---

## Phase 2 — GitHub → AWS deploy wiring (2–3 hours)

The deploy workflows (`.github/workflows/deploy-api.yml`,
`deploy-frontends.yml`) use **OIDC** — no long-lived AWS keys are stored in
GitHub. You must create the role and tell GitHub about it:

1. **Create the deploy IAM role** in AWS trusting GitHub's OIDC provider
   (`modules/api-service/README.md` describes the trust policy). 
2. **Set repo/environment variables** (Settings → Secrets and variables →
   Actions → *Variables*, not secrets — these are ARNs, not secrets):
   - `AWS_DEPLOY_ROLE_ARN` — the role from step 1
   - `DB_MASTER_SECRET_ARN` — RDS master secret ARN (a Terraform output)
   - `DB_ADDRESS` — RDS endpoint (Terraform output)
   - `APP_SECRETS_ARN` — the app secrets ARN (Terraform output)
3. **Protect the `production` GitHub Environment** (Settings → Environments →
   production → *Required reviewers* = you). Then a production deploy needs a
   human approval click, not just a button press.
4. **Deploy:** Actions → `deploy-api` → run on `staging`, verify, then
   `production`. Then `deploy-frontends` the same way. The API workflow runs
   migrations, rotates the DB role passwords out of their dev defaults, deploys
   to ECS with an automatic-rollback circuit breaker, and seeds reference data
   (production seed does **not** create demo accounts).

---

## Phase 3 — Domain, TLS & the fail-fast secrets (2–4 hours)

1. **Register a domain** (or delegate one to Route53). Then set
   `manage_dns = true` and `root_domain = "yourdomain.com"` in the tfvars and
   `terraform apply` again — it issues + validates ACM certs and points DNS at
   the right targets automatically for `api.`, `app.` (FleetHQ), and `driver.`
   (DriverOS). (If your registrar isn't Route53, `infra/README.md` → "Adding a
   real domain" covers the manual-cert path; the FleetHQ/DriverOS certs **must**
   be issued in us-east-1.)
2. **Set a strong `JWT_SECRET`** (≥32 random chars) in the app Secrets Manager
   secret. The API **refuses to boot** in production with the placeholder or a
   weak secret — this is deliberate. (Same fail-fast rejects any dev-default DB
   password that survived, so confirm the deploy's rotation step ran.)

---

## Phase 4 — Turn on the paid/external integrations (as you need them)

Each of these is **off by default** and the app degrades gracefully until you
set it — so none blocks a pilot, but each is required before the corresponding
feature is real.

| Feature | What you do | Where |
|---|---|---|
| **Outbound email** (verify/reset/invite, digests) | Verify a From address in **AWS SES** (in ap-southeast-2), move SES out of sandbox, set `email_from_address` in tfvars | `production.tfvars`; grants the ECS task a scoped SES permission |
| **Attachment storage in S3** (POD/fault photos) | Set `enable_attachments_bucket = true` before real photo volume (inline-in-Postgres is fine for a pilot) | `production.tfvars` |
| **Billing (Stripe)** | Create a Stripe account, create live-mode Prices, put the API keys in the app secret, set `billing_enforced = true` + the three `stripe_price_*` ids | `production.tfvars` + Secrets Manager |
| **Error tracking (Sentry)** | Create a Sentry project, put the DSN in the app secret | Secrets Manager |

---

## Phase 5 — Prove it before customers depend on it (1–2 days)

- [ ] **Restore drill.** Do a timed point-in-time RDS restore into a throwaway
      instance and record the actual RPO/RTO. This is the one DR item that
      cannot be proven from code — it needs the live AWS environment. (Runbook:
      `docs/compliance/audit-engagement.md` / backup-DR docs.)
- [ ] **End-to-end smoke test on production**: create a company, invite an
      operator, run a multi-stop job on a real tablet through DriverOS, capture
      POD, confirm it appears in FleetHQ and the receipt PDF renders.
- [ ] **Load check** against staging with the bundled load tool
      (`apps/api/scripts/load-test.ts`) at your expected fleet size.
- [ ] **Independent penetration test.** Engage a firm (scope: cross-tenant
      access first — RFP in `docs/compliance/audit-engagement.md`). Required
      before selling to security-conscious buyers, and an ISO A.5.35 control.

---

## Phase 6 — Security & compliance to close before you *sell* (parallel, weeks)

These don't block a friendly pilot, but a security-conscious enterprise buyer
will ask for them. Most are organisational, not code:

- [ ] **Enable branch protection** on `main` (require PR review + status checks
      + the CODEOWNERS review that's already committed).
- [ ] *(Optional, paid)* **Enable GitHub Advanced Security** to get the Security
      tab dashboard + PR-time dependency review. Then flip `upload: true` in
      `.github/workflows/security-scan.yml` (CodeQL) — the scans already run
      without it, this just surfaces them in GitHub's UI.
- [ ] **Assign named owners** to every ISMS role and **sign the policies** —
      replace every *TBD* in `docs/compliance/` (governance-execution.md is the
      fill-in register).
- [ ] **Schedule the quarterly management review**; keep the risk register live.
- [ ] **Execute DPAs** with AWS, Stripe, SES (sub-processor register in
      governance-execution.md).
- [ ] **HR controls**: onboarding security training, NDAs, offboarding checklist.
- [ ] **Engage an ISO 27001 body / SOC 2 CPA firm** and run the SOC 2 **Type II
      observation period** (3–12 months). Your audit log + CI history are the
      evidence base. Runbooks in `docs/compliance/audit-engagement.md`.

> **Honest representation (important):** until an external report exists, do
> **not** tell customers FleetOS "is ISO 27001 certified" or "is SOC 2
> compliant." You *can* accurately say it is **built to** ISO 27001 / SOC 2
> controls and is **pursuing certification**, and share this documentation and a
> SOC 2 Type I / bridge letter once obtained. Overclaiming here is the fastest
> way to fail a procurement security review.

---

## Phase 7 — Start selling

- [ ] **Publish the legal docs** (ToS, Privacy Policy, DPA drafts exist in the
      Playbook `14-Security/` — have a lawyer review, then host them and link
      from signup).
- [ ] **Appoint a Privacy Officer** (Australian Privacy Act / NDB) — the breach
      procedure is in the incident-response doc.
- [ ] **Turn on billing** (Phase 4) with live Stripe pricing, set
      `billing_enforced = true`.
- [ ] **Onboard your first pilot** (the company you had in mind) — with real
      data, on the domain, with email + S3 on. Use their feedback to prioritise.
- [ ] **Sell to the next ones** with: a working product, this documentation set,
      a completed pentest, and "pursuing ISO 27001 / SOC 2" — then convert to
      "certified" once the external reports land.

---

### The shortest honest path to a first paying pilot
Phase 1 (stand up prod) → Phase 2 (deploy) → Phase 3 (domain + JWT secret) →
Phase 4 email + S3 → Phase 5 restore drill + smoke test. That's a deployable,
sellable-to-a-friendly-first-customer product. Phases 6–7 (pentest, signed
policies, certification, published legal, live billing) run in parallel and are
what open up security-conscious enterprise buyers.
