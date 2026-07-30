# Go-Live Runbook (A1)

The end-to-end sequence to take FleetOS from "green in CI" to a live,
internet-reachable, smoke-tested production environment — the A1 workstream of
`17-Roadmap/Launch_Readiness_Plan.md`. Everything the *code/config* can do is
done and committed; what remains is execution against a real AWS account plus a
few real third-party accounts, which only the founder can provide.

This runbook ties together three things already in the repo:
- `infra/README.md` — the one-time infra bootstrap + `terraform apply` steps.
- `infra/terraform/modules/api-service/README.md` — the per-environment API
  bootstrap sequence (image, migrate, rotate, seed).
- `.github/workflows/deploy-api.yml` + `deploy-frontends.yml` — the deploy
  pipelines (manual `workflow_dispatch`, OIDC to AWS, no stored keys).

Follow it top to bottom. **Do staging first, always**; only touch production
once staging has passed the smoke test.

---

## 0. What you must provide (nobody else can)
- An **AWS account** with billing, in which you can create IAM roles.
- A **domain name** (optional for the first apply — AWS gives you
  `*.cloudfront.net` / ALB DNS until you wire one).
- Real third-party accounts, each of which drops a value into the `secrets`
  module's Secrets Manager secret: **Sentry** (DSNs), **Stripe** (live secret
  key + webhook secret + price ids), **SES** (a verified From address/domain),
  and **VAPID** keys for web push (generate with `npx web-push generate-vapid-keys`).
- A monitored **alert email** (or a paging inbox).

## 1. Provision the infrastructure
Follow `infra/README.md` §"First-time setup" verbatim:
1. Bootstrap Terraform state (`infra/terraform/bootstrap`).
2. Fill `backend-{staging,production}.hcl` and `{staging,production}.tfvars`.
3. `terraform apply -var-file=staging.tfvars` (staging first).

The config validates clean (`terraform validate`) and now also wires the A2/A3
runtime config (see §5). Leave `manage_dns=false` and the ACM ARNs empty for
the first apply.

## 2. Create the GitHub → AWS OIDC deploy role (one-time)
The deploy workflows assume no long-lived AWS keys — they assume an IAM role via
GitHub OIDC. Create it once (Terraform intentionally does **not**, to avoid a
chicken-and-egg where the thing that deploys is itself deployed by the thing it
deploys):

1. Add the GitHub OIDC provider to IAM (`token.actions.githubusercontent.com`,
   audience `sts.amazonaws.com`) if the account doesn't have one.
2. Create a role whose **trust policy** allows
   `repo:dylanjkf/FleetOS:environment:production` and `:staging` (or
   `:ref:refs/heads/*`) to assume it via that provider.
3. Grant it a scoped **permissions policy** covering what the two workflows do:
   ECR push (`ecr:*` on the `fleetos-*-api` repos + `ecr:GetAuthorizationToken`),
   ECS (`ecs:RegisterTaskDefinition`, `UpdateService`, `DescribeServices`,
   `DescribeTaskDefinition`, and `iam:PassRole` for the task/execution roles),
   Secrets Manager `GetSecretValue`/`DescribeSecret` on the `fleetos-*` secrets,
   S3 `s3:PutObject`/`DeleteObject`/`ListBucket` on the two site buckets, and
   CloudFront `CreateInvalidation`.

## 3. Wire the GitHub repo/environment variables
The workflows read these as GitHub **Actions variables** (Settings → Secrets and
variables → Actions → Variables), most straight from `terraform output`:

| GitHub variable | Source (`terraform output` in `environments/base`) |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the role ARN from step 2 |
| `DB_MASTER_SECRET_ARN` | `db_master_user_secret_arn` |
| `DB_ADDRESS` | `db_address` |
| `APP_SECRETS_ARN` | `app_secrets_arn` |
| `CLOUDFRONT_DISTRIBUTION_ID_FLEETHQ` | `cloudfront_distribution_id_fleethq` |
| `CLOUDFRONT_DISTRIBUTION_ID_DRIVEROS` | `cloudfront_distribution_id_driveros` |

Set these per **GitHub Environment** (`staging`, `production`) so each deploy
uses the right account/resources. On the `production` environment, add
**required reviewers** so a prod deploy needs a human approval click.

## 4. First deploy (staging), then smoke test
1. Run the **deploy-api** workflow against `staging`. It builds+pushes the
   image, runs `prisma migrate deploy`, rotates the DB app-role passwords to
   match the secret, registers a new task definition, deploys, waits for the
   service to stabilise (the ECS circuit breaker auto-rolls-back on failure),
   and seeds the system role templates.
2. Run the **deploy-frontends** workflow against `staging` (builds both SPAs,
   syncs to S3, invalidates CloudFront).
3. **Smoke test** the deployed staging URLs (`terraform output fleethq_url` /
   `api_url`):
   - Sign up a company → **verify the email link works** (requires §5 SES) →
     log in.
   - Create an asset + operator; create a job; add a stop; on DriverOS complete
     the stop with a photo/signature; **download the POD receipt** from FleetHQ.
   - Confirm the dispatch board, live-location panel, and reports render.
   - Trigger **forgot-password** and complete a reset.

## 5. Turn on the real integrations (fill the secret placeholders)
The `secrets` module seeds generated values for `jwt_secret` and the DB role
passwords (ready to use) and **empty placeholders** for the rest. Fill these in
Secrets Manager, then re-run the relevant deploy so the new task picks them up:

- **SES email** (A2 + notifications): verify a domain/address in SES in
  `region`, set `email_from_address` in the tfvars and `terraform apply`. The
  API's `APP_BASE_URL` is now derived automatically from the managed domain (or
  set `app_base_url` explicitly) so verification/reset/invite links are correct.
- **Web push**: set `vapid_public_key` / `vapid_private_key` in the secret.
- **Sentry**: set `sentry_dsn_api` / `sentry_dsn_fleethq` / `sentry_dsn_driveros`.
- **Stripe billing** (A3): set `stripe_secret_key` + `stripe_webhook_secret` in
  the secret; create the webhook endpoint at `https://<api>/v1/billing/webhook`;
  put the **live price ids** in the tfvars (`stripe_price_starter/pro/enterprise`).
  Leave `billing_enforced=false` until you've tested the full subscribe→active
  flow with a real card, then flip it to `true` to enforce plan limits.

## 6. Add the domain (optional but expected before selling)
Follow `infra/README.md` §"Adding a real domain": set `manage_dns=true` +
`root_domain`, `terraform apply`. Certificates and DNS for `api`, `app`
(FleetHQ), and `driver` (DriverOS) subdomains are created and validated
automatically.

## 7. Production
Repeat §1 (`production.tfvars`), §4, §5 against production, behind the
required-reviewer gate. Then re-run the **A4 restore drill** and a **load test**
(`apps/api/scripts/`) against the real environment, per
`14-Security/Production_Operations.md`.

## Rollback
Every API deploy registers a new ECS task-definition revision and keeps the
previous one. If a deploy is bad:
- The **circuit breaker** auto-rolls-back a deploy that never stabilises.
- To roll back a deploy that stabilised but is wrong: re-run **deploy-api** with
  the previous good commit (its image tag is `github.sha`), or
  `aws ecs update-service --task-definition <previous-revision-arn>
  --force-new-deployment`.
- **Migrations are forward-only** — a rollback restores the previous *image*,
  not the schema. Schema changes must stay backward-compatible across one
  deploy (expand/contract); a destructive schema change needs a restore from
  the snapshot/DR path, which is why the A4 restore drill exists.

## Status of this workstream
- Code/config: **done** — Terraform validates; the A2/A3 runtime env
  (`APP_BASE_URL`, `BILLING_ENFORCED`, `STRIPE_PRICE_*`) is now wired into the
  ECS task definition; the missing deploy-variable outputs (`db_address`,
  CloudFront distribution ids) are exposed.
- Execution: **blocked on the founder** providing the AWS account, domain, and
  the third-party accounts in §0. Nothing else stands between here and a live
  environment.
