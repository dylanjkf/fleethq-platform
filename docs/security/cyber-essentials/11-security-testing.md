# Security testing

## Intent

Security controls decay silently unless they are continuously exercised. The goal
is that the properties this platform depends on — tenant isolation, access
control, safe input handling, an intact audit trail — are asserted by automated
tests that run on every change, backed by static analysis and dependency
scanning, so a regression fails the build rather than reaching production.

## What's implemented

- **Tenant isolation is a tested invariant.** A dedicated e2e suite drives the
  real HTTP API as two separate tenants and proves neither can read the other's
  data through the RLS-constrained runtime role.
  `apps/api/test/tenant-isolation.e2e-spec.ts`.
- **Access-control and audit properties are tested.** The audit-log suite proves
  the trail records the right events, is gated by `audit:view` (403 without it),
  and is tenant-isolated; the auth-completeness suite covers lockout, verification,
  and reset. `apps/api/test/audit-log.e2e-spec.ts`, `apps/api/test/auth-*.e2e-spec.ts`.
- **Large, behaviour-level e2e suite.** The API test suite runs against a real
  Postgres with migrations applied (72 suites / 307 tests at the time of writing),
  exercising the actual request path, RLS, and permission guards rather than
  mocks — the honest way to test database-enforced security. Run in CI by
  `.github/workflows/api-ci.yml`.
- **Input-handling assertions.** Upload magic-byte sniffing (a text file
  mislabelled `image/png` is rejected), VIN/registration uniqueness races, and
  strong-password rejection are covered by unit/e2e tests
  (`apps/api/src/attachments/attachments.service.spec.ts`,
  `apps/api/src/common/validators/is-strong-password.validator.spec.ts`).
- **Dependency updates (Dependabot).** Dependabot opens update PRs for the API's
  npm dependencies and the GitHub Actions toolchain. `.github/dependabot.yml`. See
  [04-patch-and-vulnerability-management.md](./04-patch-and-vulnerability-management.md).
- ⏳ **Planned — SAST, dependency-audit gate, secret scanning, IaC scanning.**
  CodeQL (`security-and-quality`), an `npm audit` gate, `dependency-review`,
  gitleaks, and `terraform validate` + tfsec are **not wired** — there is no
  `security-scan.yml`, no `terraform-ci.yml`, and no IaC. These are the automated
  static/scan controls this domain still needs.
- **Scale/performance regression test.** A seeded 12,000-stop dataset asserts a
  report stays correct, uses the expected index (via `EXPLAIN`, no seq-scan), and
  returns within budget. `apps/api/test/scale-performance.e2e-spec.ts`.
- **A documented self-review.** `FleetOS-Playbook/14-Security/Security_Review.md`
  records a review against the OWASP API Security Top-10 categories and the fixes
  applied.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **No independent penetration test.** All security testing to date is by the team that wrote the code; `Security_Review.md` is explicit that it is not a substitute for an external, adversarial assessment. | medium | Commission an independent penetration test before/just after the first enterprise customer's data lands. |
| **No dynamic application security testing (DAST).** All automated testing is white-box (SAST + dependency audit + e2e); no scanner runs against a deployed, running instance. | low | Add a DAST pass (e.g. ZAP baseline) against a staging deployment in CI. |
| Test coverage is collected but not enforced. `jest.config.js` gathers coverage, but CI runs `npm test` with no `coverageThreshold`, so coverage can silently regress. | low | Add a `coverageThreshold` and run coverage in CI, at least for the security-critical modules (auth, permissions, prisma/RLS, audit). |
| Authentication negative tests do not explicitly cover a tampered / wrong-signature / expired JWT. The suite covers unauthenticated (401) and revoked (`TOKEN_REVOKED`), but not a forged token. | low | Add cases asserting a tampered-signature and an expired token are both rejected. |
| **No SAST / dependency-audit gate / secret scanning / IaC scanning in CI.** There is no `security-scan.yml` and no `terraform-ci.yml`; automated static and scan-based testing is absent (Dependabot aside). | medium | Add the security-scan workflow (CodeQL + `npm audit` gate + dependency-review + gitleaks) and, once IaC exists, IaC scanning — carried in [04](./04-patch-and-vulnerability-management.md) and [06](./06-secure-development-lifecycle.md). |
| **No container-image scan gate.** There is no registry/deploy pipeline in this repo (Railway builds and runs the image); nothing scans the built image or gates a rollout on findings. | medium | Once a registry/deploy pipeline exists, gate deployment on an image scan — carried in [04-patch-and-vulnerability-management.md](./04-patch-and-vulnerability-management.md). |

## Standards mapping

**Cyber Essentials:** ongoing assurance. Automated regression testing of security
properties (the e2e suites via `api-ci.yml`) plus Dependabot is a solid base;
**SAST and dependency/secret scanning gates are ⏳ planned**, and an external test
is the missing independent assurance.

**ISO/IEC 27001:2022 Annex A:** A.8.29 (security testing in development and
acceptance) — *partial*: strong e2e coverage in CI, but SAST and scan gates are
planned; A.8.8 (management of technical vulnerabilities) — partial on discovery
(Dependabot in force; scan gates planned), see domain 4.

**SOC 2 (2017 TSC):** CC4.1 (monitoring of controls via evaluations) and CC7.1
(vulnerability detection). The e2e pipeline and Dependabot partially support both;
the automated SAST/SCA gates, an independent assessment, and enforced coverage
would strengthen the evidence.
