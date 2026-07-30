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
- **Encryption at rest.** RDS storage is encrypted with a customer-managed KMS
  key with rotation enabled (`infra/terraform/modules/database/main.tf` —
  `aws_kms_key.rds`, `storage_encrypted`). S3 attachment and site buckets use
  SSE-KMS, are versioned, and have full public-access blocks
  (`infra/terraform/modules/api-service/main.tf`,
  `infra/terraform/modules/frontend/main.tf`).
- **Encryption in transit.** TLS 1.2/1.3 is terminated at CloudFront/ALB with
  HTTP→HTTPS redirect and HSTS (preload), and connections to the database are now
  forced onto TLS (`rds.force_ssl=1` + `sslmode=require`). See
  [01-secure-network-architecture.md](./01-secure-network-architecture.md).
- **Secrets never at rest in the app image.** Database credentials and the JWT
  secret are injected from AWS Secrets Manager at container start, never baked
  into the image or task definition. `infra/terraform/modules/api-service/main.tf`.
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
| The attachments bucket lacks an object **lifecycle** policy (old noncurrent versions are retained indefinitely). *(A TLS-only `aws:SecureTransport` deny bucket policy is now in place — `infra/terraform/modules/api-service`.)* | low | Add a lifecycle policy to expire noncurrent versions after the erasure/retention window. |

## Standards mapping

**Cyber Essentials:** *Secure configuration* (data protection). Encryption in
transit and at rest, tenant isolation, and a deletion path are in place; erasure
completeness and retention are the open items.

**ISO/IEC 27001:2022 Annex A:** A.8.24 (cryptography) — met; A.8.10 (information
deletion) — partial (erasure defeated by S3 versioning); A.5.12 (classification)
— not yet implemented; A.8.11/8.12 (masking / leakage prevention) — partial.

**SOC 2 (2017 TSC):** CC6.5/CC6.7 (data protection & disposal), and the
Confidentiality criteria C1.1/C1.2 (identification and disposal of confidential
information). Strong on protection; disposal completeness and retention are the
gaps.
