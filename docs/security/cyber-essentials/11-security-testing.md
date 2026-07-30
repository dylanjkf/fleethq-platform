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
- **Static application security testing (SAST).** CodeQL runs over all repository
  JS/TS with the stricter `security-and-quality` query suite on every push/PR and
  weekly. `.github/workflows/security-scan.yml`.
- **Dependency & secret scanning.** `npm audit` (fails on high/critical in
  production dependencies), `dependency-review` on PRs, and gitleaks secret
  scanning run in CI; Dependabot opens update PRs. See
  [04-patch-and-vulnerability-management.md](./04-patch-and-vulnerability-management.md).
- **Infrastructure-as-code scanning.** `terraform validate` + tfsec run on any
  change under `infra/terraform/**`. `.github/workflows/terraform-ci.yml`.
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
| The container image is scanned on push to ECR (OS-package level) but the scan does not gate the deploy. | medium | Gate deployment on the image scan result — carried in [04-patch-and-vulnerability-management.md](./04-patch-and-vulnerability-management.md). |

## Standards mapping

**Cyber Essentials:** ongoing assurance. Automated regression testing of security
properties + SAST + dependency scanning is a strong continuous-assurance posture;
an external test is the missing independent assurance.

**ISO/IEC 27001:2022 Annex A:** A.8.29 (security testing in development and
acceptance) — well met by the e2e/SAST/dependency pipeline; A.8.8 (management of
technical vulnerabilities) — met on discovery, see domain 4.

**SOC 2 (2017 TSC):** CC4.1 (monitoring of controls via evaluations) and CC7.1
(vulnerability detection). The automated pipeline supports both; an independent
assessment and enforced coverage would strengthen the evidence.
