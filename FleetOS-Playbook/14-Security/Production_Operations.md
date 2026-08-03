<!-- planned-infra-doc -->
> ⚠️ **Planned / target architecture — not yet provisioned.** Parts of this document describe the intended AWS deployment (RDS, KMS, CloudFront, ECS/Fargate, Secrets Manager, and `infra/terraform/*` modules). **That infrastructure does not exist in this repository yet** — a repo-wide search for `infra/terraform` returns only documentation, no `.tf` files. Statements below that read as present-tense fact describe the *target* state; treat them as planned until the Terraform is actually committed. The app currently deploys to Railway (see `api/README.md` and `FleetOS-Playbook/.../Go_Live_Runbook.md`).

# Production Operations Runbook

## Purpose
The pre-sale hardening tie-offs from `17-Roadmap/Launch_Readiness_Plan.md` (A4):
the operational proofs and policies that turn "configured" into "verified".
Backups, load capacity, secret rotation, and PII handling all had code or infra
in place — this file records how to actually exercise them, and the standing
policies around them.

## Backup restore drill
Backups being configured is not the same as a restore being proven.
`apps/api/scripts/restore-drill.sh` proves it end to end: it dumps the live
database, restores that dump into a throwaway scratch database, and verifies the
restored copy matches the source row-for-row on the key tables, then drops the
scratch database. The source database is never touched.

```
DATABASE_URL=postgres://…/fleetos ./scripts/restore-drill.sh
```

- Run it on a schedule (weekly is a sensible floor) and **before any risky
  migration**, so a real recovery is never the first time a restore has been
  attempted.
- The connecting role needs `CREATEDB` — in production run it as the RDS master
  / an admin role, not the RLS-scoped app role. `ADMIN_URL` overrides the
  connection used for `CREATE/DROP DATABASE` if it must differ.
- **Verified 2026-07-23** against the local database: dump → restore → row-count
  match all green.
- This drill validates *logical* restore. It complements — does not replace —
  the infra-level automated snapshots + cross-region snapshot copy already in
  `infra/terraform/modules/database` (the disaster-recovery layer from the
  backups/DR work). A full DR game-day (restore a snapshot into a fresh
  environment and boot the app against it) is the next rung up, once a live
  environment exists.

## Load / capacity
`apps/api/scripts/load-test.ts` (+ `seed-load-test-data.ts` to populate a
realistic dataset first) is the load harness. Pre-launch, run it **against the
deployed staging environment**, not a local box — the point of the tie-off is to
measure the real network/RDS/Fargate path, not a laptop. Capture p95 latency and
error rate at target concurrency and keep the run output with the launch
checklist.

## Secrets rotation
- **Database role passwords**: `apps/api/scripts/rotate-db-role-passwords.ts`
  rotates the app/auth role credentials. Schedule it (quarterly, or immediately
  on any suspected exposure), and update the corresponding secret in AWS Secrets
  Manager (`infra/terraform/modules/secrets`) in the same change so the running
  service picks up the new value.
- **JWT_SECRET, Stripe keys, VAPID keys, SES config**: live in Secrets Manager,
  injected as env at deploy. Rotating JWT_SECRET invalidates all sessions
  (acceptable, forces re-login) — do it on a suspected key compromise. Stripe /
  VAPID rotation follows each provider's key-rollover procedure.

## Log PII policy
Logs must never carry a credential or personal-data field. Enforced in code
(`apps/api/src/app.module.ts` pino config): the `Authorization` header, cookies,
and common secret keys (`password`, `passwordHash`, `newPassword`, `token`,
`tokenHash`) are redaction-removed at the log root and one level down. Request
bodies are not logged automatically. When adding a log line, never interpolate a
raw secret or an operator's personal data into the message — log an id and look
the rest up out-of-band.

## Status / uptime
Not yet stood up (no live environment). Once deployed: a lightweight external
uptime monitor hitting `GET /health` (the app's existing health endpoint) with
alerting to the same destination as the CloudWatch alarms from the monitoring
module, plus a simple public status page. Tracked as a go-live (A1) step, not a
code gap.
