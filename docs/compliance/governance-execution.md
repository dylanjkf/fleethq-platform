# Governance execution records (Phase 2)

> **What this is:** the fill-in-the-blank **records** that turn the drafted ISMS
> into an operating one. A repository cannot *be* the accountable human, *sign* a
> policy, or *execute* a legal agreement — those are human/legal acts. This
> document provides the exact tables to complete so nothing is left to invent.
> **Until the owners, dates, and signatures below are filled in by real people,
> these controls are "designed" but not "operating."**

## 2.1 Ownership register

Assign a **named individual** to each ISMS role and policy. The frameworks
require accountable owners, not functions.

| Role / Policy | Owner (name) | Assigned date |
|---------------|--------------|---------------|
| ISMS Owner (overall accountability) | ____________ | ______ |
| Security Officer | ____________ | ______ |
| Privacy Officer (Australian Privacy Act / NDB) | ____________ | ______ |
| Incident Lead (on-call) | ____________ | ______ |
| Information Security Policy | ____________ | ______ |
| Access Control Policy | ____________ | ______ |
| Cryptography Policy | ____________ | ______ |
| Data Classification & Retention Policy | ____________ | ______ |
| Secure Development Policy | ____________ | ______ |
| Acceptable Use & Endpoint Policy | ____________ | ______ |
| HR Security Policy | ____________ | ______ |
| Supplier / Vendor Management Policy | ____________ | ______ |
| Business Continuity & DR | ____________ | ______ |

## 2.2 Policy sign-off log

Management approval makes a policy authoritative. Record each here.

| Policy | Approved by | Role | Date | Version | Next review |
|--------|-------------|------|------|---------|-------------|
| Information Security Policy | ________ | ________ | ______ | 1.0 | +12 months |
| Access Control Policy | ________ | ________ | ______ | 1.0 | +12 months |
| Cryptography Policy | ________ | ________ | ______ | 1.0 | +12 months |
| Data Classification & Retention | ________ | ________ | ______ | 1.0 | +12 months |
| Secure Development Policy | ________ | ________ | ______ | 1.0 | +12 months |
| Acceptable Use & Endpoint | ________ | ________ | ______ | 1.0 | +12 months |
| HR Security Policy | ________ | ________ | ______ | 1.0 | +12 months |
| Supplier / Vendor Management | ________ | ________ | ______ | 1.0 | +12 months |

## 2.3 Management review log

Schedule and record the **quarterly** ISMS management review (ISO Clause 9.3 /
SOC 2 CC1–CC5). Agenda: risk-register changes, incidents since last review,
audit/scan findings and remediation, control-effectiveness, policy changes,
resourcing.

| Review date | Attendees | Key decisions / actions | Next review |
|-------------|-----------|-------------------------|-------------|
| ______ | ________ | ________ | ______ |

## 2.4 Sub-processor & DPA register

Data Processing Agreements must be **executed** with each sub-processor handling
personal data (drafts exist in `FleetOS-Playbook/20-Legal`).

| Sub-processor | Purpose | Data shared | DPA status | Last reviewed |
|---------------|---------|-------------|-----------|---------------|
| Amazon Web Services (ap-southeast-2) | Hosting, storage, DB | All tenant data (encrypted) | ☐ Execute | ______ |
| Stripe | Billing / payments | Billing contact, card (Stripe-held) | ☐ Execute | ______ |
| AWS SES | Transactional email | Recipient email, message content | ☐ Execute (covered by AWS DPA) | ______ |

Each sub-processor is itself ISO 27001 / SOC 2 attested; retain their current
reports on file and review annually.

## 2.5 HR security checklist

Complete for every staff member / contractor with access to FleetOS systems.

**Onboarding**
- ☐ Background screening (where lawful and role-appropriate)
- ☐ Signed employment terms including confidentiality / NDA
- ☐ Security-awareness training completed (date: ______)
- ☐ Access granted per least privilege (role: ______)
- ☐ **MFA enrolled** on their FleetOS account
- ☐ Endpoint verified: full-disk encryption, auto-lock, supported OS, anti-malware

**Annually**
- ☐ Security-awareness refresher
- ☐ Access recertification (still least-privilege for current role)

**Offboarding (same day as departure)**
- ☐ FleetOS access revoked (membership deactivated — immediate + audited)
- ☐ Tokens invalidated (tokenVersion bump / password reset)
- ☐ Company assets returned
- ☐ Removed from sub-processor consoles (AWS/Stripe/etc.)

## Status

Every item above is a **record to be completed by a named person**. When the
tables are filled and the policies signed, Phase 2 is complete and the
organisational half of ISO 27001 Clauses 5–7 / SOC 2 CC1–CC5 moves from
*designed* to *operating* — the state an auditor can then observe.
