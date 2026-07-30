# Secure development lifecycle

## Intent

The secure development lifecycle (SDLC) is the set of automated gates that stand
between a code change and FleetOS's production tenants. For a multi-tenant fleet
SaaS holding several companies' operational and personal data behind one
codebase, a single unreviewed regression — a dropped authorization guard, a
newly-vulnerable dependency, a leaked credential, an infrastructure
misconfiguration — can breach every tenant at once. This theme's goal is to make
those failure modes *fail the build* rather than reach a running instance:
scanning every change for known-vulnerable dependencies, unsafe code, and leaked
secrets; validating the infrastructure-as-code; enforcing a secure-by-default
coding and configuration baseline; and shipping only through a controlled,
auditable deployment path.

## What's implemented

### Automated security scanning in CI

- **A dedicated security-scan workflow runs four independent gates on every push
  to `main`, every pull request, and weekly.** The weekly cron catches advisories
  published against code that has not changed since the last push. The workflow
  is least-privilege by default (`permissions: contents: read`), with jobs
  widening scope only where required. `.github/workflows/security-scan.yml:12-21`
- **Dependency (SCA) vulnerability scanning.** A matrix job runs
  `npm audit --omit=dev --audit-level=high` against each of the three deployables
  (`api`, `fleethq`, `driveros`), failing the build on any high/critical
  vulnerability in *production* dependencies — the code that actually ships to a
  running instance or a user's browser. A second informational pass audits the
  full tree without failing. `.github/workflows/security-scan.yml:24-50`
- **Static analysis (SAST).** A CodeQL job analyses all JavaScript/TypeScript in
  the repo with the `security-and-quality` query suite (a stricter bar than the
  default security set) and uploads SARIF to the GitHub Security tab
  (`security-events: write`). This is the automated detector for injection,
  unsafe-sink, and taint-class defects that the linters do not cover.
  `.github/workflows/security-scan.yml:52-69`
- **Dependency-review on pull requests.** A PR-only job compares the PR's
  dependency delta against the base branch and fails if it would introduce a
  known-vulnerable package (`fail-on-severity: high`), stopping a new bad
  dependency before it merges. `.github/workflows/security-scan.yml:71-81`
- **Secret scanning.** A gitleaks job scans the full history (`fetch-depth: 0`)
  on every run, blocking a committed credential from reaching the tree. The
  ruleset starts from gitleaks' full built-in set and adds only a tightly-scoped
  allowlist for the intentional dev-only placeholders (docker-compose passwords,
  `.env.example`, the CI test secret) that grant access to nothing real — the
  same placeholders `env.validation.ts` rejects in production.
  `.github/workflows/security-scan.yml:83-92`, `.gitleaks.toml:11-30`

### Dependency currency & supply-chain patching

- **Dependabot keeps all three lockfiles and the CI toolchain patched.** There is
  a `package-ecosystem: npm` entry for `apps/api`, `apps/fleethq`, and
  `apps/driveros`, plus a `github-actions` entry for the pinned action versions,
  all on a weekly schedule. Routine minor/patch bumps are grouped into one PR per
  app to keep the review queue sane, while Dependabot's security updates are
  opened immediately and ungrouped. `.github/dependabot.yml:10-51`

### Continuous integration gates

- **Each deployable has its own CI workflow enforcing lint, typecheck, build, and
  test.** `api-ci` additionally provisions a Postgres service, applies all
  migrations (which create the RLS roles), smoke-tests the seed bootstrap, and
  runs the full Jest e2e suite — including the tenant-isolation, permissions, and
  auth-completeness suites — against a live database.
  `.github/workflows/api-ci.yml:65-81`, `.github/workflows/fleethq-ci.yml:34-41`,
  `.github/workflows/driveros-ci.yml:34-41`
- **A permission-parity gate prevents the deliberately-duplicated permission
  catalog from drifting.** The catalog is duplicated between the API and FleetHQ
  (separate deployables, no shared package); `permission-parity.yml` fails the
  build whenever `scripts/check-permission-parity.mjs` detects the two have
  diverged — a security-relevant class of bug (an access-control rule present on
  one side but not the other) caught in CI. `.github/workflows/permission-parity.yml`

### Infrastructure-as-code validation

- **The Terraform that defines the production topology is validated and
  security-scanned in CI.** `terraform-ci.yml` runs `terraform fmt -check
  -recursive`, a backend-less `terraform validate`, and a **tfsec** static IaC
  scan with `soft_fail: false`, so a change that opens the database security
  group, flips `publicly_accessible = true`, drops the HTTP→HTTPS redirect, or
  removes an encryption setting fails the PR before `terraform apply`. The
  workflow is least-privilege (`permissions: contents: read`).
  `.github/workflows/terraform-ci.yml`

### Secure-by-default coding & configuration baseline

- **Fail-fast environment validation at boot.** `validateEnv` runs during
  `ConfigModule` startup, before a single request is served. It always requires
  the three database URLs and a JWT signing secret; in production it additionally
  rejects the in-repo placeholder JWT secret, a sub-32-character secret, and — a
  hardening added in the current wave — any connection string still containing a
  well-known dev-only Postgres role password (`fleetos_dev_only` /
  `fleetos_app_dev_only` / `fleetos_auth_dev_only`), so a missed
  password-rotation step crashes the process instead of silently serving traffic
  with a guessable credential. `apps/api/src/config/env.validation.ts:33-80`
- **Secure-by-default request handling.** `main.ts` applies `helmet` with an
  explicit, strong HSTS policy (`maxAge` 63072000 = 2 years, `includeSubDomains`,
  `preload`) rather than helmet's 180-day default, and a global `ValidationPipe`
  with `whitelist: true` + `forbidNonWhitelisted: true` + `transform: true`, so
  unexpected request fields are stripped/rejected at the boundary across every
  endpoint. `apps/api/src/main.ts:38-60`
- **JWT verification pins the signature algorithm.** The passport-jwt strategy
  sets `algorithms: ['HS256']` and `ignoreExpiration: false`, foreclosing
  algorithm-substitution attacks (`alg: none`, RS256-as-HMAC) rather than
  accepting whatever the token header claims.
  `apps/api/src/auth/strategies/jwt.strategy.ts:14-24`

### Controlled, auditable deployment & change traceability

- **Production deploys are manual, human-gated, and keyless.** `deploy-api.yml`
  is `workflow_dispatch`-only (a person decides when a migration-bearing deploy
  happens), targets a GitHub Environment so `production` can require a reviewer's
  approval click in repo settings, and assumes AWS via OIDC (`id-token: write`)
  so no long-lived AWS keys are stored in GitHub at all. The deployed image is
  tagged with the exact commit SHA. `.github/workflows/deploy-api.yml:9-57`
- **The deploy has a tested rollback path and rotates credentials on every run.**
  It rotates the database app-role passwords from Secrets Manager, then registers
  a new ECS task definition and waits for the service to stabilise — the point at
  which the ECS deployment circuit breaker's automatic rollback engages on
  failure. The post-deploy seed step is pinned to `NODE_ENV=production`, which
  gates the seed to reference data + system-role reconciliation only and excludes
  the local-dev demo companies that carry a well-known default password.
  `.github/workflows/deploy-api.yml:77-117`, `apps/api/prisma/seed.ts:155-163`
- **Privilege and admin actions leave an append-only audit trail.** Change
  management for access-control state is traceable: an `audit_logs` table with
  `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy, granted only
  `SELECT, INSERT` (no `UPDATE`/`DELETE`, so entries cannot be rewritten), backs
  an `AuditService` whose `recordInTx` writes atomically inside the mutating
  transaction. Role permission-set changes, user create/role-change/revoke, and
  GPS device-key rotation now emit their declared events.
  `apps/api/prisma/migrations/20260724120000_audit_log/migration.sql:26-35`,
  `apps/api/src/audit/audit.service.ts:66-69`,
  `apps/api/src/roles/roles.service.ts:178`,
  `apps/api/src/users/users.service.ts:112`,
  `apps/api/src/gps/gps.service.ts:146`

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **The deploy pipeline does not verify a green CI run for the exact SHA being shipped.** `deploy-api.yml` builds and rolls out the dispatched commit without querying its check-suite status, so a `workflow_dispatch` could ship a SHA whose `api-ci`/`security-scan` never passed. Partially mitigated by manual-dispatch-only triggering and the GitHub Environment reviewer gate, but nothing programmatically links deploy to green CI. | high | Add a prerequisite job that queries the commit's required-status-check / check-suite state via the GitHub API and aborts the deploy if it is not passing (or make `api-ci` + `security-scan` prerequisite jobs of the deploy). |
| **Branch protection and mandatory code review are not evidenced from the repository.** There is no `CODEOWNERS`, no PR template, and no in-repo branch-protection ruleset requiring a PR, an approving review, or required status checks on `main` — so the CI gates above are only *advisory* until a human enables them as required checks. (Confirmed absent: no `.github/CODEOWNERS`, no `PULL_REQUEST_TEMPLATE`.) | high | Enable a `main` ruleset requiring a PR, ≥1 approving review, dismiss-stale-approvals, and the `api-ci` / `fleethq-ci` / `driveros-ci` / `permission-parity` / `security-scan` / `terraform-ci` checks as required status checks; add a `CODEOWNERS` file. This is a GitHub/Terraform setting plus one in-repo file. |
| **Test coverage is collected but not enforced.** `jest.config.js` sets `collectCoverageFrom` but has no `coverageThreshold`, and `api-ci` runs plain `npm test` without `--coverage`, so a change that drops a guard or adds an uncovered endpoint does not fail the build on coverage grounds. | medium | Add a `coverageThreshold` (at minimum over `src/common/guards`, `src/auth`, and the RLS/tenant paths) and run tests with `--coverage` in `api-ci.yml`; consider a diff-coverage gate. |
| **CI supply-chain hardening is partial.** Third-party Actions are pinned to mutable major tags (`actions/checkout@v4`, `github/codeql-action@v3`, `aws-actions/configure-aws-credentials@v4`) rather than full commit SHAs, so a repointed tag could alter a workflow. `security-scan.yml` and `terraform-ci.yml` declare least-privilege `permissions`, but `api-ci.yml`, `fleethq-ci.yml`, `driveros-ci.yml`, and `permission-parity.yml` do not. | low | Pin third-party actions to full commit SHAs (Dependabot's `github-actions` ecosystem already proposes the bumps) and add an explicit `permissions: contents: read` block to the four remaining CI workflows. |
| **Path-filtered app CI can skip app test suites.** `api-ci`, `fleethq-ci`, `driveros-ci`, and `permission-parity` trigger only on changes under their own paths, so a PR touching only shared/root/infra files runs no app test suite, and path-filtered checks are awkward to make always-required status checks. (`security-scan` and `terraform-ci` do run repo-wide / on all PRs, so scanning coverage is unaffected.) | low | Add an aggregating "required checks passed" gate job, adopt GitHub required workflows, or use a merge queue so every PR is covered by a stable required status check regardless of which paths it touches. |

## Standards mapping

- **Cyber Essentials — Secure configuration (development practices).** Strongly
  met at the technical layer: SCA, SAST, secret scanning, dependency-review, IaC
  scanning, and a secure-by-default coding/config baseline all run automatically
  on every change, and deploys are keyless (OIDC) and human-gated. The residual
  weakness is *enforcement* — these gates are not yet required by a branch
  ruleset, so the organisational half of the control is outstanding.
- **ISO/IEC 27001:2022 Annex A 8.25 — Secure development lifecycle.** Met: the
  pipeline defines distinct build/test/scan/deploy stages with security gates
  woven through, and a fail-fast configuration-validation boundary at boot.
  Formal branch-protection and mandatory review would complete it.
- **A.8.28 — Secure coding.** Met at the automated level: CodeQL SAST plus a
  secure-by-default runtime (helmet/HSTS, whitelisting `ValidationPipe`, pinned
  JWT algorithm, fail-fast env validation). No documented secure-coding standard
  or peer-review requirement is enforced yet.
- **A.8.29 — Security testing in development and acceptance.** Met: dependency
  audit, dependency-review, secret scan, IaC scan, and the security-focused e2e
  suites (tenant-isolation, permissions, auth) all run in CI. Gaps: coverage is
  not enforced, and there is no DAST (tracked in the Security testing domain).
- **A.8.32 — Change management.** Partially met: changes flow through
  SHA-tagged, manually-approved deploys with an automatic ECS rollback path, and
  access-control changes are captured in an append-only audit trail. The missing
  piece is a required-review / required-status-check gate proving every change
  was reviewed and green before merge and deploy.
- **SOC 2 (2017 TSC) — CC8.1 (change management).** Partially met: the technical
  controls for authorising, testing, and deploying changes exist and are
  auditable, but the control's evidence expectations (documented review approval,
  segregation between author and approver, a green-CI-before-deploy linkage) rest
  on the branch-protection and deploy-gating gaps above being closed.
