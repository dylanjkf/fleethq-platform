# Secure data handling

## Intent

FleetOS holds other companies' personal and operational data — driver contact
details and licence/medical document numbers, customer addresses, GPS positions,
and delivery proof. Secure handling means that data is encrypted in transit and
at rest, isolated per tenant, retained only as needed, deletable on request, and
that access to it is controlled and recorded.

## What's implemented

- **Tenant isolation by the database.** Every tenant read/write runs under
  PostgreSQL row-level security via `prisma.withTenant(companyId, …)`, so one
  company's data is invisible to another at the datastore layer, not merely
  filtered in application code. `apps/api/src/prisma/prisma.service.ts`; see
  [03-access-control.md](./03-access-control.md). Exercised by
  `apps/api/test/tenant-isolation.e2e-spec.ts`.
- **Encryption at rest.** ⏳ **Planned — not built in this repo.** The target is
  RDS storage encrypted with a customer-managed, rotating KMS key and SSE-KMS,
  versioned, public-access-blocked S3 buckets — but there is **no IaC** defining
  any of it. At-rest encryption today is whatever the managed platform (Railway
  Postgres, and S3 if `ATTACHMENTS_BUCKET` is configured) provides by default.
- **Encryption in transit.** TLS 1.2/1.3 is terminated by the managed edge
  (Railway/Vercel) with HTTP→HTTPS redirect, the API advertises strong HSTS, and
  DB connection strings request `sslmode=require`. Server-side forced DB TLS
  (`rds.force_ssl`) is ⏳ planned. See
  [01-secure-network-architecture.md](./01-secure-network-architecture.md).
- **Secrets never at rest in the app image.** Database credentials and the JWT
  secret are supplied as **environment variables (Railway Variables)** at runtime,
  never baked into the image or the repository. Env fail-fast rejects a dev-only
  credential in production. (A managed secret store such as AWS Secrets Manager is
  a ⏳ planned option, not currently used.)
- **Australian Privacy Act access & erasure.** An admin-initiated path exports
  an Operator's personal data (a machine-readable access request) and erases it
  by field-level redaction that keeps referencing records resolving —
  name/contact/last-known-GPS cleared, document numbers nulled, and the actual
  attachment bytes deleted (including the S3 object, not just the inline row).
  Both are recorded in the audit log. `apps/api/src/privacy/privacy.service.ts`,
  `apps/api/src/attachments/attachment-storage.ts`; policy in
  `FleetOS-Playbook/14-Security/Privacy_Data_Protection.md`.
- **Access logging for privileged data actions.** Data export and erasure, and
  the privilege changes that grant access to data, are written to the append-only
  audit log — see [09-security-monitoring-and-audit-logging.md](./09-security-monitoring-and-audit-logging.md).
- **PII kept out of logs.** The `authorization` header is redacted and request
  bodies are not logged, so credentials and posted personal data do not reach the
  log stream.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **Erasure vs S3 versioning.** The attachments bucket has versioning enabled, so deleting the current object on a Privacy-Act erasure can leave a prior *version* of the file recoverable — the erasure is not complete at the storage layer. | high | On erasure, delete all object versions (or apply a lifecycle/legal-hold-aware permanent delete) rather than issuing a single `DeleteObject`. |
| **No retention or purge for GPS breadcrumb history.** `gps_pings` is append-only and grows unbounded; there is no policy that trims location history, which is personal information. | high | Add a retention window and a scheduled purge job for `gps_pings`, and document the retention period. |
| Export/erase covers only the Operator data subject and only single records — there is no customer-subject path and no tenant-wide export. | medium | Extend the data-subject tooling to Customer PII and add a tenant-level export for offboarding. |
| No formal data classification. Sensitive fields (operator email/phone, customer contacts, compliance document numbers) are not tagged with a classification that drives handling rules. | medium | Introduce a lightweight data-classification scheme and map fields to it, informing masking, logging, and retention. |
| The attachments bucket (once configured) would lack an object **lifecycle** policy, and a TLS-only `aws:SecureTransport` deny bucket policy is **⏳ planned, not built** (no IaC / no bucket defined in this repo). | low | When the S3 backend is provisioned, add the TLS-only bucket policy and a lifecycle policy to expire noncurrent versions after the erasure/retention window. |

## Standards mapping

**Cyber Essentials:** *Secure configuration* (data protection). Tenant isolation,
in-transit encryption (managed edge), and a deletion path are in place;
encryption **at rest** is ⏳ planned (no KMS/IaC — currently the platform default),
and erasure completeness and retention are open items.

**ISO/IEC 27001:2022 Annex A:** A.8.24 (cryptography) — partial (in-transit met;
KMS-at-rest planned); A.8.10 (information deletion) — partial (erasure defeated by
S3 versioning where S3 is used); A.5.12 (classification) — not yet implemented;
A.8.11/8.12 (masking / leakage prevention) — partial.

**SOC 2 (2017 TSC):** CC6.5/CC6.7 (data protection & disposal), and the
Confidentiality criteria C1.1/C1.2 (identification and disposal of confidential
information). Strong on protection; disposal completeness and retention are the
gaps.
