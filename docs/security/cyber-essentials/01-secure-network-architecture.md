# Secure network architecture

## Intent

FleetOS is a multi-tenant SaaS that holds several fleet operators' delivery,
compliance, and personal data in one PostgreSQL system of record. The network
architecture exists to make the database — and the application tier in front of
it — unreachable except through a single, TLS-terminated, deny-by-default path,
so that the row-level-security tenant model has a hardened perimeter to sit
behind rather than being the only line of defence. The goal is a topology where
"who can even open a socket to this component" is answered by the network before
authentication or authorisation is ever consulted.

## What's implemented

### Network segmentation and topology

- **A single VPC split into public and private subnets across two AZs, with
  data and compute tiers denied any public IP.** Public subnets carry only the
  ALB and the NAT gateways; the ECS tasks and RDS live in private subnets that
  never receive a public address. `infra/terraform/modules/network/main.tf:32-49`
  (`aws_subnet.public` sets `map_public_ip_on_launch = true`; `aws_subnet.private`
  deliberately does not).
- **The database is never internet-reachable.** RDS is placed in the private
  subnet group and is explicitly not publicly accessible, so there is no
  direct-from-internet path to Postgres at all.
  `infra/terraform/modules/database/main.tf:78` (`publicly_accessible = false`)
  and `:7-11` (`aws_db_subnet_group.main` over the private subnets).
- **ECS Fargate tasks run in private subnets with no public IP.** The API
  service assigns no public address and is only routed to via the ALB.
  `infra/terraform/modules/api-service/main.tf:352-358`
  (`assign_public_ip = false`, private subnets).

### Deny-by-default security groups (three-tier)

- **Each tier accepts traffic only from the tier in front of it.** The security
  groups form a strict chain rather than a flat network:
  - The ALB security group is the only one open to the internet, and only on
    443 (plus 80, which the listener immediately redirects). `infra/terraform/modules/network/main.tf:102-130`.
  - The API task security group accepts the app port **only** from the ALB
    security group — not from any CIDR. `infra/terraform/modules/network/main.tf:132-153`
    (`aws_security_group.api_service` ingress `security_groups = [aws_security_group.alb.id]`).
  - The database security group accepts 5432 **only** from the API task
    security group. `infra/terraform/modules/network/main.tf:155-176`
    (`aws_security_group.database` ingress `security_groups = [aws_security_group.api_service.id]`).

  Ingress is expressed as source-security-group references, so widening the
  perimeter requires a deliberate, reviewable change rather than an accidental
  `0.0.0.0/0`.

### Single public ingress and TLS everywhere

- **The ALB is the one public entry point, and plaintext is redirected, not
  served.** The HTTP:80 listener issues a 301 to HTTPS; nothing is forwarded
  over cleartext. `infra/terraform/modules/api-service/main.tf:317-330`
  (`aws_lb_listener.http_redirect`).
- **The HTTPS listener pins a modern cipher policy.** The 443 listener uses
  `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2/1.3, modern ciphers only).
  `infra/terraform/modules/api-service/main.tf:332-343`.
- **CloudFront enforces HTTPS to viewers and to the origin.** Both SPA and
  `/v1/*` behaviours use `redirect-to-https`, the viewer certificate pins a
  minimum of `TLSv1.2_2021`, and the custom origin to the ALB is
  `https-only` over TLS 1.2. `infra/terraform/modules/frontend/main.tf:114-144`
  and `:166-171`.
- **Connections to RDS are forced to use TLS.** The parameter group sets
  `rds.force_ssl = 1` so the server refuses cleartext sessions, and the app/auth
  Prisma connection strings request `sslmode=require` to match. This closes the
  in-transit-to-database exposure: even a misconfigured or compromised in-VPC
  host cannot open a plaintext session to Postgres.
  `infra/terraform/modules/database/main.tf:34-37` (`aws_db_parameter_group.main`)
  and `infra/terraform/environments/base/main.tf:71-72` (`app_database_url`,
  `auth_database_url`).

### Encryption at rest

- **RDS storage is encrypted with a customer-managed KMS key that rotates.**
  `infra/terraform/modules/database/main.tf:42-46` (`aws_kms_key.rds`,
  `enable_key_rotation = true`) and `:59-60` (`storage_encrypted = true`,
  `kms_key_id`).
- **The attachments bucket is SSE-KMS encrypted, versioned, and fully
  public-access-blocked.** `infra/terraform/modules/api-service/main.tf:130-156`.
- **SPA buckets are private and only reachable through CloudFront.** Public
  access is fully blocked and the bucket policy grants `s3:GetObject` only to
  the CloudFront distribution via Origin Access Control (source-ARN condition).
  `infra/terraform/modules/frontend/main.tf:12-58`.

### Edge and origin security headers

- **CloudFront injects a strong security-header set on the SPA responses.**
  A response-headers policy sets HSTS (max-age 2 years, `includeSubDomains`,
  `preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a
  `strict-origin-when-cross-origin` referrer policy, and a narrow CSP
  (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`).
  `infra/terraform/modules/frontend/main.tf:60-89`.
- **The API origin now advertises matching HSTS itself.** `helmet` is
  configured with an explicit 2-year `max-age` + `includeSubDomains` + `preload`
  rather than the library's ~180-day default, so responses served through the
  `/v1/*` CloudFront behaviour carry the same HSTS strength as the SPA domains
  even though that behaviour takes its headers from the origin.
  `apps/api/src/main.ts:38-42`.

### Request-abuse control at the entry point

- **Global per-IP rate limiting is applied as the first guard in the chain.**
  `@nestjs/throttler` runs before auth and authorisation (cheapest check first),
  capping requests per IP per minute and tightened further on the login route.
  This is the application-tier abuse control that currently stands in for an
  edge WAF. `apps/api/src/app.module.ts:115-121` (`ThrottlerModule.forRoot`) and
  `:171` (`ThrottlerGuard` registered as the first `APP_GUARD`). Correct client
  IP attribution behind the CDN/ALB relies on `trust proxy` being set —
  `apps/api/src/main.ts:24`.

### Least-privilege runtime and secret handling

- **The application task role starts empty and is granted only narrowly scoped
  permissions.** The ECS execution role and task role are deliberately
  separated; the task role gets no policies unless a feature needs one (SES
  scoped by From-address condition, S3 get/put scoped to the single attachments
  bucket). `infra/terraform/modules/api-service/main.tf:84-171`.
- **All secrets are resolved from Secrets Manager at container start, never
  baked into the image or task definition.** JWT, VAPID, Sentry, Stripe, and the
  assembled DB connection strings are injected as `secrets` references.
  `infra/terraform/modules/api-service/main.tf:231-251`.
- **ECR images are immutable and scanned on push.** A deployed tag cannot be
  silently repointed. `infra/terraform/modules/api-service/main.tf:4-11`
  (`image_tag_mutability = "IMMUTABLE"`, `scan_on_push = true`).

### Resilience of the topology

- **Multi-AZ everywhere the outage would cost money.** Two AZs with a NAT
  gateway per AZ (`infra/terraform/modules/network/main.tf:60-67`) and a
  synchronous RDS standby (`infra/terraform/modules/database/main.tf:73`,
  `multi_az`) mean a single-AZ failure does not sever outbound connectivity or
  the database.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| No VPC flow logs on the VPC or subnets, so there is no network-level record of accepted/rejected traffic for the segmented subnets. Forensics or detection of attempted lateral movement or a security-group misconfiguration would have no data source. Confirmed absent — no `aws_flow_log` in `infra/terraform`. | medium | Add an `aws_flow_log` on `aws_vpc.main` (`traffic_type = ALL`) delivering to a CloudWatch Logs group or S3 bucket in `modules/network`, with a defined retention window. |
| No ALB access logs. `aws_lb.main` has no `access_logs` block, so there is no per-request log at the edge for incident investigation or abuse analysis independent of the app's own pino logs. Confirmed absent in `modules/api-service`. | low | Enable `access_logs` on `aws_lb.main` to a dedicated, access-blocked, encrypted S3 bucket with a lifecycle expiry. |
| The 15 MB JSON body limit is applied globally (`app.useBodyParser('json', { limit: '15mb' })`), so every endpoint — not just attachment/photo-ingest routes — accepts up to 15 MB, giving a wider memory/DoS amplification surface than necessary. `apps/api/src/main.ts:29`. | low | Keep a small default JSON limit globally (e.g. 256 KB–1 MB) and raise the 15 MB limit only on the specific attachment/photo-ingest routes via a scoped body-parser or per-route middleware. |

Previously-tracked items now closed and reflected above rather than listed here:
in-transit encryption to RDS is now enforced (`rds.force_ssl` + `sslmode=require`);
the origin-vs-edge HSTS inconsistency is resolved by explicit `helmet` HSTS
matching the CloudFront policy; the IaC security/regression gate now exists
(`.github/workflows/terraform-ci.yml` runs `terraform fmt -check`, `validate`,
and a tfsec scan on `infra/terraform/**`); and an **AWS WAFv2** edge layer is now
in place — REGIONAL web ACL associated to the ALB and a CLOUDFRONT web ACL on the
SPA distributions, each with the AWS managed common + known-bad-inputs rule
groups and a per-IP rate-based rule (`infra/terraform/environments/base/waf.tf`).

## Standards mapping

**Cyber Essentials — Firewalls.** Strong. The three-tier, source-security-group,
deny-by-default topology with a single 443 ingress point, no publicly accessible
datastore, and no public IPs on the compute/data tiers is a textbook boundary
firewall configuration. The residual is the absence of an application-layer
firewall (WAF) at the edge.

**Cyber Essentials — Secure configuration.** Strong on the network surface:
modern TLS policies end to end, forced TLS to the database, encryption at rest
with a rotating KMS key, immutable scanned images, and least-privilege task
roles with secrets injected at runtime. The gap is that these settings are not
yet guarded by an IaC regression check.

**ISO/IEC 27001:2022 A.8.20 Network security.** Met at the infrastructure level:
segmented VPC, controlled ingress/egress, and TLS on every hop. Weakened by the
lack of flow-log-level network monitoring.

**ISO/IEC 27001:2022 A.8.21 Security of network services.** Met: each network
service (ALB, ECS, RDS, CloudFront/S3) has an explicitly defined, minimal access
boundary and a defined cipher/TLS baseline. No edge L7 filtering yet.

**ISO/IEC 27001:2022 A.8.22 Segregation of networks.** Strong: public/private
subnet split and the source-security-group chain enforce tier segregation, and
tenant segregation is enforced beneath this by database RLS (see
`03-access-control.md`).

**ISO/IEC 27001:2022 A.8.24 Use of cryptography.** Met: TLS 1.2/1.3 in transit
at the ALB, CloudFront, origin-to-ALB hop, and now to RDS; KMS-managed
encryption at rest for RDS and S3 with key rotation enabled.

**SOC 2 (2017 TSC) CC6.1 (logical access boundaries).** Supported by the
deny-by-default security groups and private-subnet placement of all sensitive
components.

**SOC 2 (2017 TSC) CC6.6 (protection against threats from outside the system
boundary).** Partially met: perimeter firewalling and TLS are strong, but the
absence of a WAF and of edge/flow logging leaves outside-threat detection thin.

**SOC 2 (2017 TSC) CC6.7 (protection of data in transit).** Met: HTTPS is forced
and redirected at every public hop, HSTS is advertised from both the CDN and the
origin, and database connections are now forced onto TLS.
