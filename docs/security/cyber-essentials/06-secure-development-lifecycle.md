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

> **Status of this domain.** What is **implemented in this repository** is the
> `api-ci.yml` gate, Dependabot, the scheduled restore drill, and the
> secure-by-default coding/config baseline (below). The dedicated **security-scan
> workflow** (SCA gate, CodeQL SAST, dependency-review, gitleaks) and the
> **terraform-ci** IaC scan this doc previously described **do NOT exist** — there
> is no `security-scan.yml`, no `terraform-ci.yml`, and no IaC. Those are retained
> under "Target architecture" and clearly labelled ⏳ Planned.

## What's implemented

### Continuous integration gate (the API)

- **`api-ci.yml` provisions a Postgres service, applies all migrations (which
  create the RLS roles), smoke-tests the seed bootstrap, builds, and runs the full
  Jest e2e suite** — including the tenant-isolation, permissions, and
  auth-completeness suites — against a live database, plus lint and typecheck.
  `.github/workflows/api-ci.yml`. (The frontends and DriverOS are separate
  repositories with their own CI.)
- **A scheduled dump/restore drill** (`.github/workflows/restore-drill.yml`)
  round-trips the database dump/restore weekly so a schema/restore regression
  fails CI.

### Dependency currency & supply-chain patching

- **Dependabot keeps the API's dependencies and the CI toolchain patched.** A
  `package-ecosystem: npm` entry for `/api` plus a `github-actions` entry, on a
  weekly schedule with grouped minor/patch bumps. `.github/dependabot.yml`.

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

- **Production deploys are managed-platform gated, and migrations run
  automatically.** The API deploys to **Railway** (Dockerfile builder,
  `api/railway.json`); every deploy runs `prisma migrate deploy` before the server
  starts (`api/docker-entrypoint.sh`). Railway keeps the previous deploy for
  rollback. The seed's production path is gated by `NODE_ENV=production`, which
  restricts it to reference data + system-role reconciliation and excludes the
  local-dev demo companies that carry a well-known default password.
  `api/prisma/seed.ts` (production short-circuit). The DB app-role passwords are
  rotated out of their dev defaults with `npm run db:rotate-role-passwords`, and
  env fail-fast refuses to boot if a dev-only password survives.
- **Privilege and admin actions leave an append-only audit trail.** Change
  management for access-control state is traceable: an `audit_logs` table with
  `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy, granted only
  `SELECT, INSERT` (no `UPDATE`/`DELETE`, so entries cannot be rewritten), backs
  an `AuditService` whose `recordInTx` writes atomically inside the mutating
  transaction. Role permission-set changes, user create/role-change/revoke, and
  GPS device-key rotation emit their declared events.
  `api/prisma/migrations/20260724120000_audit_log/migration.sql`,
  `api/src/audit/audit.service.ts`, `api/src/roles/roles.service.ts`,
  `api/src/users/users.service.ts`, `api/src/gps/gps.service.ts`

## ⏳ Target architecture (planned — NOT yet implemented)

None of the following exists in this repository (no `security-scan.yml`, no
`terraform-ci.yml`, no `deploy-api.yml`, no IaC). Treat each as Planned:

- **A dedicated security-scan workflow** running four gates on push/PR/weekly:
  an `npm audit` SCA gate, **CodeQL** SAST (`security-and-quality` suite, SARIF to
  the Security tab), **dependency-review** on PRs, and **gitleaks** secret
  scanning over full history. A `.gitleaks.toml` allowlist for the intentional
  dev-only placeholders would accompany it.
- **Infrastructure-as-code validation** (planned) — `terraform fmt`/`validate` + a
  **tfsec** scan gating a change that opens a security group, flips
  `publicly_accessible`, or removes an encryption setting. Not yet built — requires
  IaC to exist first.
- **A keyless deploy pipeline** — `workflow_dispatch`, GitHub Environment reviewer
  gate, OIDC to a cloud role, SHA-tagged immutable images, and an automatic
  rollback circuit breaker — for a future AWS/registry topology.
- **A permission-parity gate** — a CI check that the permission catalog stays in
  sync between the API and the FleetHQ frontend. Because those now live in
  separate repositories, this is a cross-repo check to be wired, not an in-repo
  workflow here.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **No CI security-scan or IaC-scan gate exists.** There is no `security-scan.yml` (SCA gate / CodeQL / dependency-review / gitleaks) and no `terraform-ci.yml`, so a vulnerable dependency, a leaked secret, or a SAST-detectable defect is not blocked at merge. `api-ci.yml` covers lint/typecheck/test/build only. | high | Add the `security-scan.yml` described under Target architecture (and `terraform-ci.yml` once IaC exists). |
| **Branch protection and mandatory code review are not evidenced from the repository.** There is no `CODEOWNERS`, no PR template, and no in-repo branch-protection ruleset requiring a PR, an approving review, or required status checks on `main` — so `api-ci.yml` is only *advisory* until a human enables it as a required check. (Confirmed absent: no `.github/CODEOWNERS`.) | high | Enable a `main` ruleset requiring a PR, ≥1 approving review, dismiss-stale-approvals, and the `api-ci` / `restore-drill` (and, once built, `security-scan`) checks as required status checks; add a `CODEOWNERS` file. |
| **No deploy-to-green-CI linkage.** Railway deploys the connected branch; nothing programmatically blocks a deploy of a SHA whose `api-ci` did not pass. | medium | Gate the Railway deploy on the branch's required status checks, or add a check-suite verification step. |
| **Test coverage is collected but not enforced.** `jest.config.js` sets `collectCoverageFrom` but has no `coverageThreshold`, and `api-ci` runs plain `npm test` without `--coverage`. | medium | Add a `coverageThreshold` (at minimum over `src/common/guards`, `src/auth`, and the RLS/tenant paths) and run with `--coverage` in `api-ci.yml`. |
| **CI action pinning is partial.** Third-party Actions in `api-ci.yml`/`restore-drill.yml` are pinned to mutable major tags (`actions/checkout@v4`, `actions/setup-node@v4`) rather than full commit SHAs, and the workflows do not declare an explicit `permissions:` block. | low | Pin third-party actions to full commit SHAs (Dependabot's `github-actions` ecosystem proposes the bumps) and add an explicit `permissions: contents: read` block. |

## Standards mapping

- **Cyber Essentials — Secure configuration (development practices).** *Partial.*
  The `api-ci.yml` gate and a secure-by-default coding/config baseline run on
  every change, and Dependabot drives updates. SCA/SAST/secret/IaC scanning is
  ⏳ planned (no `security-scan.yml`), and enforcement via a branch ruleset is not
  yet in place.
- **ISO/IEC 27001:2022 Annex A 8.25 — Secure development lifecycle.** *Partial.*
  The pipeline defines distinct build/test/deploy stages with a fail-fast
  configuration-validation boundary at boot; the security-scan/IaC-scan gates and
  formal branch-protection/mandatory review would complete it.
- **A.8.28 — Secure coding.** *Partial.* A secure-by-default runtime (helmet/HSTS,
  whitelisting `ValidationPipe`, pinned JWT algorithm, fail-fast env validation)
  and parameterised queries (Prisma) are implemented; CodeQL SAST and a documented
  secure-coding/peer-review standard are ⏳ planned.
- **A.8.29 — Security testing in development and acceptance.** *Partial.* The
  security-focused e2e suites (tenant-isolation, permissions, auth) run in CI via
  `api-ci.yml`; dependency audit as a gate, secret scan, and IaC scan are planned,
  coverage is not enforced, and there is no DAST (tracked in the Security testing
  domain).
- **A.8.32 — Change management.** *Partial.* Changes flow through forward-only
  migrations and a managed-platform deploy, and access-control changes are captured
  in an append-only audit trail. The missing pieces are a required-review /
  required-status-check gate and a green-CI-before-deploy linkage.
- **SOC 2 (2017 TSC) — CC8.1 (change management).** *Partial.* The technical
  controls for authorising, testing, and deploying changes exist and are auditable,
  but the evidence expectations (documented review approval, author/approver
  segregation, a green-CI-before-deploy linkage) rest on the branch-protection and
  deploy-gating gaps above being closed.
