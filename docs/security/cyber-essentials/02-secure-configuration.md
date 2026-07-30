# Secure configuration

## Intent

Secure configuration is about making sure every deployed component — the API
process, its database roles, the HTTP surface, and the CI/CD that ships them —
starts in a hardened state and cannot silently regress into a weak one. For a
multi-tenant fleet SaaS holding several companies' operational and personal
data behind one shared stack, the specific risks this theme addresses are
default/known credentials reaching a live system, a misconfigured process
serving traffic while a protection is quietly disabled, and internal detail
leaking through error or log surfaces. FleetOS's approach is to **fail fast at
boot** on any configuration that would under-secure the process, and to keep the
hardened settings in code (and infrastructure-as-code) rather than in operator
memory.

## What's implemented

### Fail-fast configuration validation at boot

- **Required configuration is asserted before the first request is served.**
  `validateEnv` runs inside `ConfigModule.forRoot({ validate })` and refuses to
  start unless the three database URLs and the JWT signing secret are all
  present and non-empty; a missing one is treated as a fatal misconfiguration,
  not a runtime surprise. `apps/api/src/config/env.validation.ts:37-53`
- **The production token-signing secret must be strong and must not be the
  in-repo placeholder.** When `NODE_ENV === 'production'`, `validateEnv` rejects
  the `.env.example` placeholder (`local-dev-only-change-me`) and enforces a
  32-character minimum, so a deployment that shipped the shared dev secret —
  which would make every session token forgeable — cannot boot.
  `apps/api/src/config/env.validation.ts:58-68`
- **Un-rotated dev database credentials fail the boot in production.**
  `validateEnv` inspects `DATABASE_URL`, `APP_DATABASE_URL`, and
  `AUTH_DATABASE_URL` and refuses to start if any still carries a well-known
  dev-only Postgres role password (`fleetos_dev_only`, `fleetos_app_dev_only`,
  `fleetos_auth_dev_only`). This turns "the deploy's password-rotation step
  didn't take" into a loud crash rather than an instance serving traffic with a
  guessable, repo-visible database credential.
  `apps/api/src/config/env.validation.ts:33` (the known-password list) and
  `apps/api/src/config/env.validation.ts:71-79` (the production check).

### No default accounts or default passwords on production

- **The demo tenants with a known default password are gated out of
  production.** `apps/api/prisma/seed.ts` provisions two loginable demo
  companies (`Acme Couriers` / `admin@acme`, `Southern Star Logistics` /
  `admin@southernstar`) whose admin password is the repo-visible constant
  `fleetos-dev-password`. That whole block is now guarded: when
  `NODE_ENV === 'production'` the script returns after seeding reference data
  only and creates no demo accounts. `apps/api/prisma/seed.ts:22` (the default
  password constant) and `apps/api/prisma/seed.ts:162-165` (the production
  short-circuit).
- **The production deploy runs the seed with `NODE_ENV=production` so only the
  safe half executes.** The deploy workflow's seed step sets
  `NODE_ENV: production` explicitly, so a production deploy runs the reference-
  data + system-role reconciliation path (`seedReferenceData`) and nothing that
  plants an account. `.github/workflows/deploy-api.yml:110-117` and the
  reference-only path at `apps/api/prisma/seed.ts:139-150`. Together these two
  controls close what would otherwise be a canonical Cyber Essentials failure —
  default credentials on a live system.
- **No long-lived platform credentials sit in the pipeline.** The deploy job
  assumes an AWS role via OIDC (`permissions: id-token: write`, no stored access
  keys) and pulls the real database and app secrets from Secrets Manager at run
  time, then rotates the app/auth DB role passwords as an idempotent step.
  `.github/workflows/deploy-api.yml:18-20`, `:36-40`, and `:77-87`.

### Hardened HTTP surface

- **Security response headers are set, with an explicit strong HSTS policy.**
  `helmet()` applies the standard header set, and HSTS is configured explicitly
  to a two-year `max-age` with `includeSubDomains` and `preload` rather than
  left on helmet's ~180-day default — the HSTS-preload-list expectation.
  `apps/api/src/main.ts:38-42`.
- **Request bodies are strictly validated and unknown fields are rejected.** The
  global `ValidationPipe` runs with `whitelist: true`,
  `forbidNonWhitelisted: true`, and `transform: true`, so any property not
  declared on a DTO is refused rather than silently passed through to a service.
  `apps/api/src/main.ts:54-60`.
- **The proxy trust boundary is set to exactly one hop.** `trust proxy` is `1`,
  matching the client → CloudFront → ALB → process topology, so `req.ip`
  resolves to the real client for per-IP rate limiting instead of collapsing
  every user into the ALB's address. `apps/api/src/main.ts:24`.
- **Per-IP rate limiting is on by default.** `ThrottlerModule` applies a global
  300-requests-per-60s default (tightened per-route on login), giving an
  internet-facing surface a baseline cost against brute-force and
  credential-stuffing. `apps/api/src/app.module.ts:115-121`.
- **JWT verification pins the accepted signature algorithm.** The passport-jwt
  strategy sets `algorithms: ['HS256']` and `ignoreExpiration: false`,
  foreclosing algorithm-substitution attacks (`alg: none`, or an RS256 token
  verified against a public key used as an HMAC secret).
  `apps/api/src/auth/strategies/jwt.strategy.ts:14-24`.

### Safe-by-default error and log handling

- **Error responses never leak internals.** The global exception filter only
  echoes an `HttpException`'s app-authored message; a raw, unhandled exception
  (a Prisma/driver error, a null-deref) is returned as a generic
  `An unexpected error occurred.` while the real exception goes to Sentry. Only
  status ≥ 500 is reported to Sentry, so expected 4xx traffic doesn't bury the
  signal. `apps/api/src/common/filters/http-exception.filter.ts:32-34` and
  `:44-54`.
- **Secrets and credentials are redacted from structured logs.** The pino logger
  removes the `authorization`/`cookie` headers and common secret keys
  (`password`, `passwordHash`, `token`, `tokenHash`, and their one-level-down
  variants) with `remove: true`, at both the log root and one level down.
  `apps/api/src/app.module.ts:88-104`.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| The schema-owning `DATABASE_URL` (the high-privilege, RLS-bypassing owner role) is required at boot for the serving process (`REQUIRED_ALWAYS`, `apps/api/src/config/env.validation.ts:37-42`) and injected into the long-running request-serving ECS task, even though no request-path code reads it — `PrismaService` binds `APP_DATABASE_URL` and `SystemPrismaService` binds `AUTH_DATABASE_URL`. This needlessly keeps an RLS-defeating credential in the request process's environment (widening RCE/SSRF/log-leak blast radius). | medium | Stop injecting `DATABASE_URL` into the runtime task definition (`infra/terraform/modules/api-service/main.tf`), scoping it to the migrate/seed/rotate job only, and change `validateEnv` to require it for tooling contexts (e.g. a `MIGRATE` flag) rather than for the serving process. |
| `NODE_ENV` is never validated against an allowlist. The production-only hardening in `validateEnv` — the JWT strength/placeholder gate and the dev-DB-password gate — is keyed on the exact string `NODE_ENV === 'production'` (`apps/api/src/config/env.validation.ts:46`), so a deploy that sets `prod`, `Production`, or leaves it unset would evaluate `isProduction = false` and silently skip both checks with no error. | low | In `validateEnv`, assert `NODE_ENV` is one of an allowed set (`production`/`staging`/`development`/`test`) and fail closed on anything else, so a misspelt environment cannot quietly disable production hardening. |
| The 15 MB JSON body limit is applied globally (`app.useBodyParser('json', { limit: '15mb' })`, `apps/api/src/main.ts:29`), so every endpoint — not just base64 photo/attachment routes — accepts up to 15 MB, a wider memory/DoS amplification surface than necessary. | low | Keep a small default JSON limit globally (e.g. 256 KB–1 MB) and raise 15 MB only on the specific attachment/photo-ingest routes via a scoped body-parser. |

Note: three findings from the original audit for this domain have since been
remediated and are recorded above under *What's implemented*, not here — default
admin accounts with a hardcoded password reaching production (HIGH), no fail-fast
that the dev-only DB role passwords were rotated (HIGH), and database connections
not forced onto TLS (`rds.force_ssl=1` + `sslmode=require` are now set — carried
in the Secure network architecture domain).

## Standards mapping

**Cyber Essentials:** Secure configuration. Well covered on the "no default
accounts/passwords" and "remove/disable insecure defaults" tenets — the demo
tenants are gated out of production, dev secrets and dev DB passwords fail the
boot, and the HTTP surface is hardened by default. The main residual is
configuration robustness (a mistyped `NODE_ENV` silently softening the posture).

**ISO/IEC 27001:2022 Annex A:**
- **A.8.9 Configuration management** — Largely met for the application tier: the
  hardened configuration is defined in code and infrastructure-as-code
  (`env.validation.ts`, `main.ts`, `app.module.ts`, the Terraform modules) and
  enforced at boot rather than applied by hand, though there is no
  allowlist/lint that a change conforms to the intended baseline.
- **A.5.37 Documented operating procedures** — Partially met: the production
  bootstrap and secret-rotation steps are encoded in `deploy-api.yml` with
  explanatory comments, but this is pipeline-as-documentation rather than a
  standalone secure-configuration standard.
- **A.8.19 Installation of software on operational systems** — Partially met:
  production seeding is constrained to reference data only and secrets are
  pulled from Secrets Manager via OIDC, but the owner DB credential still enters
  the serving container's environment unnecessarily.

**SOC 2 (2017 TSC):**
- **CC6.1** (logical access / protection of information) — Supported by
  fail-fast rejection of default credentials, algorithm-pinned JWT verification,
  and log redaction of secrets; weakened where the owner DB credential sits in
  the request process and DB TLS is not enforced.
- **CC7.1** (detection of configuration changes/vulnerabilities) — Partially
  supported: boot-time validation catches a class of misconfiguration, but there
  is no automated check that a deployed configuration matches an approved
  baseline, so this criterion is only partly met.
