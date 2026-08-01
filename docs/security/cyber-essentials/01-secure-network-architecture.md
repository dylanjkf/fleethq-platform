# Secure network architecture

## Intent

FleetOS is a multi-tenant SaaS that holds several fleet operators' delivery,
compliance, and personal data in one PostgreSQL system of record. The network
architecture's job is to make the database — and the application tier in front of
it — unreachable except through a single, TLS-terminated, deny-by-default path,
so that the row-level-security tenant model has a hardened perimeter to sit
behind rather than being the only line of defence.

> **Status of this domain.** The **application-tier** boundary controls below
> (per-IP rate limiting, HSTS, the one-hop proxy trust boundary, `sslmode=require`
> in the DB connection strings) are **implemented in `api/`** and shipped today.
> The **network/infrastructure topology** (VPC, subnets, security groups, ALB,
> RDS placement, CloudFront, KMS-at-rest, multi-AZ, WAF) is a **⏳ Planned target
> architecture** for the deployment: **there is no Terraform or other IaC in this
> repository**, so none of it is built or evidenced by a file on disk. In the
> real deployment path today the API runs on **Railway** and the frontends on
> **Vercel**, whose managed edges terminate TLS; the AWS topology described under
> "Target architecture" is the intended future state, not the current one.

## What's implemented today (application tier)

### Request-abuse control at the entry point

- **Global per-IP rate limiting is applied as the first guard in the chain.**
  `@nestjs/throttler` runs before auth and authorisation (cheapest check first),
  capping requests per IP per minute and tightened further on the login route.
  This is the application-tier abuse control that stands in for an edge WAF until
  one exists. `api/src/app.module.ts` (`ThrottlerModule.forRoot`) and the
  `ThrottlerGuard` registered as the first `APP_GUARD`. Correct client-IP
  attribution behind a CDN/proxy relies on `trust proxy` being set —
  `api/src/main.ts`.

### Transport security advertised by the origin

- **The API origin advertises a strong HSTS policy itself.** `helmet` is
  configured with an explicit 2-year `max-age` + `includeSubDomains` + `preload`
  rather than the library's ~180-day default, so responses carry a strong HSTS
  header regardless of what terminates TLS in front of them. `api/src/main.ts`.
- **The proxy trust boundary is set to exactly one hop** (`trust proxy = 1`), so
  `req.ip` resolves to the real client for per-IP rate limiting instead of
  collapsing every caller into the proxy's address. `api/src/main.ts`.
- **The DB connection strings request TLS.** `APP_DATABASE_URL` /
  `AUTH_DATABASE_URL` are expected to carry `sslmode=require` so the client
  refuses a plaintext session; on a managed Postgres (Railway/RDS) that pairs
  with a server that requires TLS. The *server-side* enforcement (e.g.
  `rds.force_ssl`) is part of the target architecture below, not an in-repo
  artifact.

## ⏳ Target architecture (planned — NOT yet implemented, no IaC in this repo)

Everything in this section describes the intended AWS production topology. **None
of it exists in the repository** — there is no `infra/terraform`, no `.tf` file,
and no deployed AWS account wired to this repo. It is retained as the design
target so the eventual build has a specification; treat every item as **Planned**,
not as a control currently in force.

### Network segmentation and topology (planned)

- A single VPC split into public and private subnets across two AZs, with the
  data and compute tiers denied any public IP: public subnets carry only the ALB
  and NAT gateways; ECS tasks and RDS live in private subnets.
- The database never internet-reachable — RDS in a private subnet group with
  `publicly_accessible = false`.
- ECS Fargate tasks in private subnets with no public IP, routed to only via the
  ALB.

### Deny-by-default security groups, three-tier (planned)

- Each tier accepts traffic only from the tier in front of it: ALB open to the
  internet on 443 (with an 80→443 redirect); the API task security group accepts
  the app port only from the ALB SG; the database SG accepts 5432 only from the
  API task SG. Ingress expressed as source-security-group references, never a
  bare `0.0.0.0/0`.

### Single public ingress and TLS everywhere (planned / partly platform-provided)

- A single public entry point that redirects plaintext to HTTPS and pins a modern
  cipher policy (TLS 1.2/1.3), with CloudFront enforcing HTTPS to viewers and to
  the origin, and forced TLS to RDS (`rds.force_ssl = 1`).
- *Today* this is provided instead by the Railway/Vercel managed edges, which
  terminate TLS for the API and the SPAs; the AWS ALB/CloudFront specifics are
  the planned replacement, not a current artifact.

### Encryption at rest (planned)

- RDS storage encrypted with a customer-managed, rotating KMS key; the
  attachments bucket SSE-KMS encrypted, versioned, and public-access-blocked; SPA
  buckets private behind CloudFront OAC. **No such infrastructure exists yet** —
  at-rest encryption in the current deployment is whatever the managed platform
  (Railway Postgres, and S3 if `ATTACHMENTS_BUCKET` is configured) provides by
  default, not a control defined in this repo.

### Edge security headers, least-privilege task role, immutable images (planned)

- A CloudFront response-headers policy injecting HSTS/`X-Frame-Options`/CSP on SPA
  responses; an ECS task role that starts empty and is granted only narrowly
  scoped permissions; secrets resolved from Secrets Manager at container start;
  immutable, scan-on-push ECR images. All planned. (In the current path, runtime
  secrets are supplied as **Railway Variables**, not Secrets Manager, and the SPA
  security headers are the frontend host's responsibility.)

### Resilience of the topology (planned)

- Multi-AZ with a NAT gateway per AZ and a synchronous RDS standby. Not built.

## Gaps & residual risk

Because the infrastructure layer is not yet built, the entire target topology
above is, in effect, the outstanding work for this domain. The application-tier
items are the only network/boundary controls actually in force today.

| Gap | Severity | Plan |
|-----|----------|------|
| **No infrastructure-as-code and no built network perimeter.** There is no VPC, security-group chain, private-subnet DB placement, WAF, or KMS-at-rest defined anywhere in this repository; the perimeter today is whatever the Railway/Vercel managed platforms provide plus the application-tier rate limiting. | high | Author the Terraform (or Railway-native equivalent) for the segmented topology above, or document and accept the managed-platform boundary explicitly as the production perimeter. |
| **No edge WAF.** The only request-abuse control on public entry points is application-level throttling. | medium | Add an L7 WAF (managed common + known-bad-inputs rule groups + a per-IP rate rule) once an AWS/managed edge is stood up. |
| **No VPC flow logs / edge access logs.** With no VPC or ALB, there is no network-level record of accepted/rejected traffic independent of the app's own pino logs. | medium | When the topology is built, enable flow logs and edge access logs to an access-blocked, encrypted store with a defined retention window. |
| The 15 MB JSON body limit is applied globally (`app.useBodyParser('json', { limit: '15mb' })`), so every endpoint — not just attachment/photo-ingest routes — accepts up to 15 MB. `api/src/main.ts`. | low | Keep a small default JSON limit globally and raise the 15 MB limit only on the specific attachment/photo-ingest routes. |

## Standards mapping

**Cyber Essentials — Firewalls / boundary.** *Partial.* The application tier
enforces per-IP rate limiting and strong transport headers, and the managed
Railway/Vercel platforms provide the network edge today. The textbook three-tier,
deny-by-default VPC topology described above is **planned, not built**, and an
edge WAF is absent — so the boundary control is not yet at the strength this
document's target describes.

**Cyber Essentials — Secure configuration (network surface).** *Partial.* Modern
TLS is provided by the managed edges and the app advertises strong HSTS; the
KMS-at-rest, immutable-image, and least-privilege-task-role hardening are part of
the unbuilt target architecture.

**ISO/IEC 27001:2022 A.8.20 Network security / A.8.21 Security of network
services / A.8.22 Segregation of networks.** *Planned at the infrastructure
level.* Tenant segregation is enforced today beneath the network by database RLS
(see `03-access-control.md`); the network-tier segregation (segmented VPC,
controlled ingress/egress, per-service boundaries) is target architecture pending
IaC.

**ISO/IEC 27001:2022 A.8.24 Use of cryptography.** *Partial.* TLS in transit is
provided by the managed edges and requested by the DB connection strings;
KMS-managed encryption at rest with key rotation is planned, not built.

**SOC 2 (2017 TSC) CC6.1 / CC6.6 / CC6.7.** *Partial.* Data-in-transit protection
(CC6.7) is supported by forced HTTPS at the managed edge and strong HSTS; the
boundary/perimeter expectations of CC6.1/CC6.6 rest largely on the planned
network topology and WAF, which are not yet in place.
