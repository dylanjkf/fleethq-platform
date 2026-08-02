# Incident response plan

## Intent

A runnable procedure for detecting, containing, and recovering from a security
incident affecting FleetOS or its customers' data, and for meeting the Australian
**Notifiable Data Breaches (NDB)** obligations under the Privacy Act 1988. This
is an operational plan; roles are placeholder-labelled and must be assigned to
named people before go-live.

> Status: this plan is documented but has not yet been exercised in a tabletop or
> live drill. Several detection steps are manual today because security-signal
> alerting is not yet wired (see
> [09-security-monitoring-and-audit-logging.md](./09-security-monitoring-and-audit-logging.md)).

## Roles

| Role | Responsibility | Assigned to |
|------|----------------|-------------|
| **Incident Lead** | Owns the incident end-to-end; declares severity; decides on containment and disclosure. | *TBD* |
| **Technical Responder(s)** | Investigates, contains, eradicates, recovers. | *TBD (on-call engineer)* |
| **Privacy Officer** | Runs the NDB assessment; owns OAIC and individual notifications. | *TBD* |
| **Communications** | Customer, internal, and (if required) public messaging. | *TBD* |

## Severity classification

| Severity | Definition | Examples |
|----------|------------|----------|
| **SEV1 — Critical** | Confirmed unauthorised access to, or loss of, customer personal data; or a control that isolates tenants has failed. | Cross-tenant data exposure (RLS bypass); database exfiltration; ransomware; leaked production credential in active use. |
| **SEV2 — High** | Credible threat to data or availability, not yet confirmed as a breach. | Leaked credential (not yet used); exploited vulnerability without confirmed data access; sustained auth-abuse / account takeover of one tenant. |
| **SEV3 — Moderate/Low** | Security-relevant event with limited or no data impact. | Isolated account lockout abuse; a dependency CVE with no known exploitation; a single failed intrusion attempt. |

## Phases

### 1. Detect & report
Sources: the append-only **audit log** (`audit_logs` — failed logins, lockouts,
privilege changes, data exports), **Sentry** (application errors, once the DSN is
set), the **hosting platform's metrics and log alerts** (Railway for the API,
Vercel for the frontends), customer reports, and the `SECURITY.md` disclosure
channel. Anyone who suspects an incident raises it to the Incident Lead
immediately.

> **Infrastructure note.** This runbook targets the current Railway (API) /
> Vercel (frontends) deployment. It does **not** assume AWS CloudWatch, Secrets
> Manager, or RDS — those are a planned target architecture, not built. Secrets
> are managed as environment variables in the hosting platform.

### 2. Triage & declare
The Incident Lead confirms the event is a real incident, assigns a severity, opens
an incident record (timestamped timeline), and pages the Technical Responder. For
SEV1/SEV2, start the clock on the NDB assessment (below) in parallel.

### 3. Contain
Stop the bleeding without destroying evidence:
- Revoke suspected-compromised sessions/accounts — bump `tokenVersion` (invalidates
  all of a user's sessions) and/or deactivate the membership.
- Rotate exposed credentials — rotate the database app-role passwords
  (`db:rotate-role-passwords`) and JWT/other secrets, updating the corresponding
  environment variables in the hosting platform (Railway/Vercel), which is where
  secrets are stored.
- If tenant isolation is implicated, consider read-only mode or taking the
  affected service offline.
- Preserve evidence *before* changing state: the `audit_logs` table is append-only
  (cannot be altered from the app) and the hosting platform retains recent logs;
  capture a database backup/snapshot via the managed database provider to preserve
  point-in-time state.

### 4. Eradicate
Remove the root cause — patch the vulnerability, revoke the foothold, invalidate
all affected credentials, and confirm no persistence remains.

### 5. Recover
Restore service from a known-good state (see
[backup-and-disaster-recovery.md](./backup-and-disaster-recovery.md)), verify
integrity and that the vulnerability is closed, and monitor closely for
recurrence.

### 6. Post-incident review
Within a defined window after resolution, run a blameless review: timeline, root
cause, what detection/response worked and what didn't, and concrete follow-up
actions (with owners) — including any control this plan revealed as missing.

## Australian NDB assessment (Privacy Act 1988)

For any incident involving personal information:
1. **Assess** whether the incident is an *eligible data breach* — unauthorised
   access/disclosure or loss of personal information that a reasonable person
   would conclude is **likely to result in serious harm**. Complete the assessment
   **expeditiously and within 30 days**.
2. If it is likely to cause serious harm and the risk cannot be remediated:
   **notify the OAIC** (Notifiable Data Breach statement) **and notify affected
   individuals** as soon as practicable.
3. If remedial action prevents the likelihood of serious harm, notification may
   not be required — document the reasoning either way.

The Privacy Officer owns this assessment; the audit log and export tooling
(`apps/api/src/privacy/privacy.service.ts`) help scope exactly whose data was
affected.

## Communications

Internal: keep the incident record current. External: for SEV1/SEV2 affecting
customer data, the Communications role, with the Incident Lead, issues factual
customer notifications (what happened, what data, what we're doing, what they
should do) coordinated with the NDB timeline. Do not disclose specifics that would
aid an attacker while the incident is live.

## Standards mapping

**Cyber Essentials:** incident management (operational readiness).

**ISO/IEC 27001:2022 Annex A:** A.5.24 (incident-management planning &
preparation), A.5.25 (assessment & decision on events), A.5.26 (response), A.5.27
(learning from incidents), A.5.28 (collection of evidence) — this plan provides
the documented procedure; drilling it and closing the alerting gap are the next
steps.

**SOC 2 (2017 TSC):** CC7.3 (evaluate security events), CC7.4 (respond to
incidents), CC7.5 (recover). Design is in place; effectiveness evidence requires
running the plan on real (or simulated) incidents.
