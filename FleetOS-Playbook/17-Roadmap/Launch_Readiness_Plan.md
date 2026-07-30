# Launch Readiness Plan — from feature-complete to first paying customer

> Written 2026-07-22. The courier vertical is feature-rich and green in CI, but
> nothing here has run in production and several go-to-market gates are
> unstarted. This plan is the bridge. It separates **what engineering builds**
> (Track A) from **external gates the founder must initiate** (Track B) — the
> external ones have long lead times, so they start *now*, in parallel, even
> though some can't finish until the app is deployed.

## Framing: "readiness" was mostly written, not run

Most launch-readiness work to date is code and config that has **never executed
against real infrastructure or real accounts**. The Terraform (network, RDS,
api-service, frontend/CDN, secrets, monitoring, DNS, DR snapshot copy) and the
CI/CD workflows (`deploy-api`, `deploy-frontends`) are authored. Billing, email
(SES), object storage (S3), and push (VAPID) are all "flip a switch" — but the
switches have never been flipped end-to-end with real credentials. That is the
core of the remaining work: **prove it in production**, not build more features.

---

## Track A — Engineering (I build these)

### A1. Go-live: deploy and run it in production  ← the true gate
Everything is verified in dev/CI only. To sell, there must be a hosted,
internet-reachable, AU-region instance.

- Bootstrap Terraform remote state (S3 + DynamoDB lock) — `infra/terraform/bootstrap` exists.
- Provision into **ap-southeast-2** (AU data residency): VPC/network, RDS Postgres, api-service (ECS/Fargate), frontend (CloudFront + S3) for both SPAs, Route53 + ACM TLS, Secrets Manager/SSM.
- Wire CI/CD: `deploy-api` runs `prisma migrate deploy` + deploys the API; `deploy-frontends` builds + publishes both SPAs. Add a **post-deploy smoke test** gate.
- Seed baseline + run `npm run permissions:sync`.
- Observability: point Sentry DSN at a real project; CloudWatch alarms → a real alert destination.
- **Production smoke test**: signup → verify email → login → create asset/operator/job → complete a stop with POD → see it on FleetHQ → download a receipt.
- **Founder inputs:** AWS account, a domain, alert destination (email/Slack), confirm AU region.

### A2. Auth completeness  ← smallest, fully buildable now, and A1 needs it
Today: login + self-service signup only. **No password reset, no email
verification.** Real customers lock themselves out day one; unverified signups
are an abuse vector.
- Email verification on signup (token email via SES).
- Forgot / reset password (token email + reset endpoint + FleetHQ UI).
- Teammate **invite acceptance** flow (today an admin creates a user directly; there's no invite email → set-password path).
- Auth-endpoint rate limiting + brute-force lockout; token expiry/refresh review.
- **Founder inputs:** a verified SES sending domain (needed for all real email).

### A3. Billing made real + entitlements  ← monetization gate
Stripe is **test-mode**, and critically **nothing enforces plans** — any company
uses every feature regardless of subscription.
- Define plan tiers (what's included; any limits — assets/operators/seats).
- **Entitlement enforcement** in the API (a guard/interceptor keyed to the company's active subscription) — the missing piece today.
- Stripe live: products/prices, live keys, webhook endpoint handling the full lifecycle (checkout completed → active → `invoice.payment_failed` → past_due → cancelled), dunning, upgrade/downgrade, trials.
- **Australian GST**: tax rates, tax-compliant invoices with ABN.
- **Founder inputs:** live Stripe account, pricing decision, ABN/GST (see B3), tax advice.

### A4. Production hardening tie-offs (pre-sale must-dos, not new features)
- **Tested backup RESTORE drill** — restore to a scratch DB and verify (backups are configured; a restore has never been proven).
- **Load test against the real prod-like environment** (scripts exist; they've only hit synthetic targets).
- Secrets rotation plan; log retention + PII scrubbing; a simple status/uptime page.

---

## Track B — External gates (founder initiates NOW; long lead times)

### B1. Security — third-party penetration test
Storing personal + safety/compliance data; buyers will ask. Engage an AU firm;
scope = deployed app + API. **Runs after A1** (needs a live target) but scope and
book it now — lead time is weeks.

### B2. Legal
Lawyer review + execution of the **ToS / Privacy Policy / DPA** drafts already in
the repo; **Australian Privacy Act (APP)** compliance review; a **Notifiable Data
Breaches** response plan; a customer order form / pilot agreement template.

### B3. Business & tax
ABN, GST registration + tax-compliant invoicing, business bank account, Stripe
payouts.

### B4. Insurance
Professional indemnity + cyber liability — weighted by FleetOS sitting inside
customers' **Chain of Responsibility / NHVR** compliance chain.

### B5. Data residency & sub-processors
Confirm AU-region hosting; document the sub-processor list (AWS, Stripe, SES) in
the Privacy Policy.

---

## Track C — The pilot (the actual bridge to "selling")
- Formalize the founder's own-company pilot: written agreement, success criteria, a feedback loop, a named owner. (Subject to their agreement — they may decline; have a second prospect.)
- Onboarding/migration dry run: import their real fleet/customers via the existing CSV import.

---

## Deliberately NOT now
- **OBD/CAN Asset Hub telemetry** — large, unstarted, but per `CLAUDE.md` hardware is never a required dependency and manual entry works. Must not gate the first sale.
- Anything in `17-Roadmap/Product_Roadmap.md` v2/v3 (other verticals, second jurisdiction, marketplace).

---

## Sequencing

| When | Engineering (me) | Founder (external) |
|------|------------------|--------------------|
| Now | A2 auth (self-contained) | Start B1–B4: request quotes, engage lawyer, ABN/GST, insurance |
| +1–2 wks | A1 go-live (needs AWS + domain); A3 entitlement build | Provide AWS/domain/Stripe; legal review in flight |
| +2–3 wks | A4 restore drill + real load test on prod infra | B1 pentest runs against the deployed app |
| +3–4 wks | Fix pentest findings; flip billing live; pilot onboarding | Finalize legal; execute pilot agreement |
| → | **First pilot / paying customer** | |

## What I can start with zero founder input
- **A2 auth** (everything except final SES-domain verification).
- **A3 entitlement-enforcement scaffolding** + the plan/tier model.
- **A4** restore-drill script + load-test harness prep.
- **A1** deployment runbook + pipeline wiring, up to the point of needing real AWS credentials.

## Owner matrix
- **Me:** A1 (automation/runbook), A2, A3 (code), A4.
- **You:** AWS account + domain, live Stripe + pricing, SES domain verification, and all of Track B (pentest, legal, ABN/GST, insurance) — plus the pilot agreement.
