<!-- planned-infra-doc -->
> ⚠️ **Planned / target architecture — not yet provisioned.** Parts of this document describe the intended AWS deployment (RDS, KMS, CloudFront, ECS/Fargate, Secrets Manager, and `infra/terraform/*` modules). **That infrastructure does not exist in this repository yet** — a repo-wide search for `infra/terraform` returns only documentation, no `.tf` files. Statements below that read as present-tense fact describe the *target* state; treat them as planned until the Terraform is actually committed. The app currently deploys to Railway (see `api/README.md` and `FleetOS-Playbook/.../Go_Live_Runbook.md`).

# Security Review — Commercial Launch Readiness (2026-07-22)

## Purpose
A self-review against common web/API vulnerability classes (OWASP API Security Top 10 categories, informally), done as part of getting v1 ready to sell to real companies (`00-Company/Commercial_Priority.md`). This is a self-review by the same team that wrote the code, not an independent audit — see "What this is not," below.

## What this is not
- **Not a substitute for an independent penetration test or professional security audit.** Recommended before or shortly after the first paying customer's data goes in, given the product now handles real company data (driver PII, compliance records, financial figures on maintenance costs).
- **Not a certification of compliance** with any specific security standard (SOC 2, ISO 27001, the Australian Privacy Act's APP 11 "reasonable security" requirement). See `Privacy_Data_Protection.md` for the privacy-law side of this, which has its own separate treatment.

## Findings and fixes

### 1. Unhandled exceptions leaked internal error details to the client (fixed)
`HttpExceptionFilter` (`apps/api/src/common/filters/http-exception.filter.ts`) previously echoed `exception.message` back to the client for **any** error, including ones that were never an `HttpException` — a raw Prisma/driver error, a null-dereference, any genuine unhandled bug. Those messages can contain schema details, internal state, or other information a client should never see. Fixed: only an `HttpException`'s message (always app-authored, deliberately thrown with a safe string) is ever returned; anything else gets a fixed `"An unexpected error occurred."` The real exception still reaches Sentry (already wired for 5xx responses) for debugging — nothing is lost, it just no longer reaches the client.

### 2. No rate limiting anywhere (fixed)
No rate limiting existed at all before this review — an internet-facing login endpoint with unlimited attempts is directly brute-forceable/credential-stuffable, and self-service signup (`POST /v1/companies`) had no cost to spamming company creation. Fixed with `@nestjs/throttler`:
- A generous app-wide default (300 requests/min per IP) applied globally via `ThrottlerGuard`, ahead of the auth/permission guards (cheapest check first).
- A tight override (10 requests/min per IP) on the three unauthenticated, credential-checking endpoints that actually matter for brute-force: `POST /v1/auth/login`, `POST /v1/auth/select-company`, `POST /v1/companies` (signup).
- The e2e suite logs in on nearly every test, so both limits are set effectively unlimited under `NODE_ENV=test` — the same convention already used for pino's log level.
- **Verified live**, not just by config inspection: ran the built app with `NODE_ENV=production` and sent 14 rapid login attempts — the first 10 returned `401` (wrong credentials, as expected), attempts 11-14 returned `429 Too Many Requests`.

### 2a. The rate limiter would have bucketed every user behind the load balancer together (fixed alongside #2)
Found while verifying #2, not before shipping it: `@nestjs/throttler` keys its per-IP bucket on Express's `req.ip`, which without `app.set('trust proxy', ...)` is the *connecting socket's* address — in production that's the ALB, the same for every request regardless of which real user sent it. Every user would have shared one 300/min (or 10/min, on the auth endpoints) bucket, meaning one user's traffic could throttle everyone else's, and an attacker's traffic would be indistinguishable from legitimate load for rate-limiting purposes. Fixed: `app.set('trust proxy', 1)` in `main.ts` (production traffic is client → CloudFront → ALB → this process — one hop to trust). **Verified live**: sent requests with distinct `X-Forwarded-For` values and confirmed each got its own fresh bucket rather than sharing the one already exhausted by the #2 test above.

### 3. Vulnerable `multer` version (fixed)
`npm audit` flagged `multer@2.0.2` (pinned by `@nestjs/platform-express`) for four DoS-class CVEs (incomplete cleanup, resource exhaustion, uncontrolled recursion, deeply-nested field names) — a production, request-path dependency (file/photo uploads), not a build-time tool. Fixed via an npm `overrides` entry pinning `multer` to `2.2.0` without needing to bump `@nestjs/platform-express` itself. Verified: the attachments and Digital Glovebox e2e suites (file upload code paths) still pass.

### 4. Remaining `npm audit` findings — reviewed, not fixed, and why
47 of the ~48 flagged vulnerabilities remain, all requiring a breaking major-version bump to resolve (`npm audit fix --force`), and all are one of:
- **Transitive through `@nestjs/cli`, `jest`, or other devDependencies** (`glob`, `picomatch`, `tmp`, `webpack`, `lodash`, `@angular-devkit/*`) — never present in the production Docker image (`apps/api/Dockerfile`'s runtime stage runs `npm ci --omit=dev`). `webpack` specifically is doubly moot: `nest-cli.json` has no `compilerOptions.builder` set, so `nest build` uses plain `tsc`, never invoking webpack at all, even locally.
- **Transitive through `autocannon`** (`uuid`, `hyperid`) — a devDependency added for this review's own load testing (`apps/api/scripts/load-test.ts`), same reasoning as above.
- **`tar` (critical), via `bcrypt`'s `@mapbox/node-pre-gyp`** — `bcrypt` *is* a production dependency, so this one does ship in `node_modules`, but the vulnerable code path (arbitrary file write during tar extraction) only runs during `npm install`, fetching bcrypt's prebuilt native binary from a fixed, first-party registry — not something reachable through the running API's request path. Accepted as a low-priority residual risk rather than chased further; there's no non-breaking fix available today (bcrypt itself would need to update its own dependency).

### 5. Reviewed and found already adequate (no change)
- **SQL injection**: Prisma is used throughout with parameterized queries; the only raw SQL is `$executeRaw` with tagged template literals (auto-parameterized) for the RLS session GUC, plus one `$executeRawUnsafe` call in `scripts/rotate-db-role-passwords.ts` that validates its password input against a strict regex before interpolating (role names come from a hardcoded list, never user input) — already reviewed when that script was built.
- **Mass assignment**: the global `ValidationPipe`'s `whitelist: true` + `forbidNonWhitelisted: true` strips/rejects any request field not explicitly declared on a DTO.
- **Password policy**: `MinLength(8)` enforced on both self-service signup and user creation DTOs; hashed with `bcrypt` (cost factor 10, the accepted OWASP-baseline minimum).
- **JWT handling**: `ignoreExpiration: false`; secret sourced from `JWT_SECRET` env var (Secrets Manager in production — see `infra/terraform/modules/secrets/`), never hardcoded; symmetric HS256 only (no RS256 keypair anywhere in the codebase, so the classic "RS256 public key used as HMAC secret" algorithm-confusion attack doesn't apply).
- **CORS**: deliberately not configured. Both frontends call the API same-origin — the Vite dev proxy locally, CloudFront's `/v1/*` origin routing in production (`infra/terraform/modules/frontend/`) — so there is no legitimate cross-origin caller to allow, and omitting CORS entirely is the more restrictive, correct default here (a browser will simply refuse to read a cross-origin response with no CORS headers).
- **CSRF**: not applicable — auth is a bearer JWT in an `Authorization` header, not an ambient cookie, so there's no session for a forged cross-site request to ride on.
- **Secrets in logs**: `nestjs-pino` redacts `req.headers.authorization`; no custom serializer logs request bodies (so login passwords are never logged).
- **Security headers**: `helmet()` applied in `main.ts`.
- **Request size limits**: JSON body capped at 15MB (photos/signatures arrive as base64 inside JSON for offline-sync reasons — see `main.ts`'s own comment); `AttachmentsService` separately caps decoded byte size.
- **Multi-tenancy isolation**: already reviewed in `02-Architecture/Scaling_And_Enterprise_Readiness.md` as "already correct" — real Postgres row-level security, not application-layer filtering — and exercised by the dedicated `tenant-isolation.e2e-spec.ts` suite.

## Recommendation
Commission an independent penetration test before or shortly after the first paying customer's real data is in the system — this review closes the gaps a self-review can reasonably find, but an external, adversarial pass is the standard next step for a product handling other companies' operational and compliance data.
