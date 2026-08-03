<!-- planned-infra-doc -->
> ⚠️ **Planned / target architecture — not yet provisioned.** Parts of this document describe the intended AWS deployment (RDS, KMS, CloudFront, ECS/Fargate, Secrets Manager, and `infra/terraform/*` modules). **That infrastructure does not exist in this repository yet** — a repo-wide search for `infra/terraform` returns only documentation, no `.tf` files. Statements below that read as present-tense fact describe the *target* state; treat them as planned until the Terraform is actually committed. The app currently deploys to Railway (see `api/README.md` and `FleetOS-Playbook/.../Go_Live_Runbook.md`).

# Database security model

Covers tenant isolation (Part 2) and database security (Part 12): row-level
security, the least-privilege role split, encryption, and defence against
injection and data leakage.

## Tenant isolation — enforced by the database

FleetOS is a shared-database multi-tenant SaaS. Isolation is **not** an
application `WHERE company_id = ?` convention that a forgotten clause could
defeat — it is **PostgreSQL row-level security**.

### How it works

1. The application connects as `fleetos_app`, a role that is **subject to** RLS.
2. Every tenant-scoped operation runs inside
   `prisma.withTenant(companyId, tx => …)`, which, at the start of the
   transaction, executes `SELECT set_config('app.current_company_id', <id>,
   true)` — setting a transaction-local GUC.
3. Every tenant table has a `tenant_isolation` policy:

   ```sql
   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "<table>"
     USING      (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
     WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
   ```

   `USING` filters what a query can **read**; `WITH CHECK` constrains what it can
   **write** — so a query cannot even insert or update a row into another
   company. `FORCE ROW LEVEL SECURITY` applies the policy to the table owner too,
   so nothing short of a `BYPASSRLS` role is exempt.

If no company context is set (GUC empty), the `NULLIF(...)::uuid` is `NULL` and
the predicate matches no rows — the tables **fail closed**, never open.

### Coverage

As verified from the live catalog, **every** tenant table (40+ of them,
including `audit_logs` and — as of DB Wave 1 — `gps_devices`/`gps_pings`) has
RLS enabled + forced with a policy. The tables without `company_id` are either
global reference data (`permissions`), user-scoped identity
(`users`, `auth_tokens`, `push_subscriptions` — visibility governed by shared
membership or user id, not company), or internal infrastructure
(`scheduler_leases`). This is exercised by `test/tenant-isolation.e2e-spec.ts`
and, for GPS, by the database-level assertion in `test/gps.e2e-spec.ts`.

> **Company A can never read Company B's data.** Even if a service method omits
> its `companyId` filter, the database returns zero rows.

## Least-privilege database roles

Three roles, separated by blast radius:

| Role | Used by | RLS | DDL | Purpose |
|------|---------|-----|-----|---------|
| **schema owner** (`DATABASE_URL`) | migrations only | owner | yes | Runs `prisma migrate deploy`; never used by the serving process. |
| **`fleetos_app`** (`APP_DATABASE_URL`) | the running API | subject | no | The runtime role — full DML on tenant tables, but every row gated by RLS. |
| **`fleetos_auth`** (`AUTH_DATABASE_URL`) | narrow pre-tenant ops | `BYPASSRLS` | no | Login username lookup, system (null-company) audit writes, and GPS device-key ingest — the handful of operations that legitimately have no company context. Granted only the specific tables/columns it needs. |

The serving container is injected only `APP_DATABASE_URL` and `AUTH_DATABASE_URL`
in production; the high-privilege owner URL is scoped to the migration/seed job,
and `env.validation.ts` refuses to boot production if a connection string still
carries a dev-only role password.

## Encryption

- **At rest.** _Planned (target architecture, not yet built — see banner above):_
  RDS storage will be encrypted with a customer-managed KMS key with rotation
  (`infra/terraform/modules/database`), and S3 attachment/site buckets SSE-KMS
  encrypted and versioned with a full public-access block. **Today** the app runs
  on Railway; volume-level at-rest encryption there is the provider's, and no
  customer-managed KMS key exists yet. The only application-level at-rest
  encryption that exists today is the Integration Hub's AES-256-GCM credential
  vault (stored integration secrets only), plus field-level hashing below.
- **In transit.** _Planned:_ TLS 1.2/1.3 from client → CloudFront/ALB → API. What
  exists today, and — as of
  the E3b infra wave — **forced TLS to the database** (`rds.force_ssl=1` +
  `sslmode=require`), so the API↔Postgres hop is encrypted, not merely private.
- **Field-level.** Sensitive-but-searchable identifiers are hashed rather than
  stored in the clear where the plaintext isn't needed for display — e.g. GPS
  device keys are stored only as a SHA-256 `device_key_hash`, and passwords as
  bcrypt hashes. Column-level encryption of PII at rest (beyond the volume-level
  KMS encryption) is a noted future option in
  [assessment.md](./assessment.md).

## Injection & data-leakage defence

- **Parameterised queries throughout.** All access is via Prisma (parameterised
  by construction). The only raw SQL is `$executeRaw` tagged templates
  (auto-parameterised) for the RLS GUC, plus one `$executeRawUnsafe` in the
  role-password rotation script whose input is validated against a strict regex
  and comes from a hardcoded role list — never user input.
- **Mass-assignment blocked.** The global `ValidationPipe` runs
  `whitelist: true` + `forbidNonWhitelisted: true`, stripping/rejecting any field
  not declared on a DTO — so a client cannot set `company_id`, `id`, or another
  privileged column it wasn't given.
- **No sensitive data in logs.** `nestjs-pino` redacts the `authorization`
  header, and no serializer logs request bodies, so credentials and posted PII
  never reach the log stream. Unhandled errors return a fixed message to the
  client (internal detail goes only to Sentry).
- **Append-only audit trail.** `audit_logs` is granted only `SELECT, INSERT`
  (no `UPDATE`/`DELETE`) to the app roles, so the security record cannot be
  rewritten from application code. See the security docs at
  [`docs/security/cyber-essentials/`](../security/cyber-essentials/).
