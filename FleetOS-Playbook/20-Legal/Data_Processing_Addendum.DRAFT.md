# FleetOS Data Processing Addendum (DPA)

> **DRAFT — PENDING AUSTRALIAN LEGAL REVIEW. NOT ENFORCEABLE. DO NOT PUBLISH OR EXECUTE.**
> Prepared by the engineering team as a starting point for a qualified lawyer, describing how FleetOS actually processes customer-controlled personal data. See `20-Legal/README.md`.

This Addendum forms part of the FleetOS Terms of Service between [DECISION NEEDED: legal entity] ("FleetOS", "Processor") and the Customer ("Controller"). It governs FleetOS's processing of personal information that the Customer controls — principally information about the Customer's operators.

## 1. Roles
1.1 The Customer is the entity responsible under the Privacy Act 1988 (Cth) for the operator personal information it enters into the platform (the "Controller"). FleetOS processes that information only as the Customer's service provider (the "Processor").
1.2 FleetOS processes personal information only to provide the platform and only on the Customer's documented instructions (which include these terms and the Customer's use of the platform's features). **[LAWYER TO CONFIRM whether Australian law requires the EU-style "controller/processor" framing or whether APP-native language is preferable.]**

## 2. Scope of processing
- **Subject matter:** provision of the FleetOS fleet-management platform.
- **Nature and purpose:** hosting, storing, transmitting, and displaying Customer-entered data to operate the Customer's fleet.
- **Categories of data subjects:** the Customer's operators and other personnel whose data the Customer enters.
- **Categories of personal information:** identity and contact details; licence and medical certificate details and scanned documents; work-hours/shift and fatigue records; job, checklist, and message history.
- **Duration:** for the term of the subscription, plus the limited post-termination export/deletion window in the Terms of Service.

## 3. FleetOS's obligations
FleetOS will:
3.1 process personal information only on the Customer's instructions and not for its own purposes;
3.2 ensure personnel with access to personal information are bound by confidentiality;
3.3 implement and maintain the technical and organisational security measures described in the Privacy Policy and `14-Security/` (row-level tenant isolation, encryption in transit, application-level at-rest encryption of stored secrets with database/disk-level at-rest encryption per the hosting platform's defaults, hashed credentials, audit logging, least-privilege access, rate limiting);
3.4 keep personal information within Australia (AWS ap-southeast-2 primary, ap-southeast-4 for disaster-recovery snapshots) and not transfer it overseas without the Customer's consent, except as disclosed for sub-processors in clause 4;
3.5 assist the Customer, taking into account the platform's built-in tools, in responding to data subject access and erasure requests (APP 12 / APP 11.2) — the platform provides self-service export and erasure so the Customer can fulfil these itself;
3.6 notify the Customer without undue delay after becoming aware of a data breach affecting the Customer's personal information, with enough information to let the Customer meet its Notifiable Data Breaches obligations; **[DECISION NEEDED: specific timeline, e.g. within 48–72 hours.]**
3.7 on termination, delete or return the Customer's personal information in accordance with the Terms of Service, except where retention is required by law.

## 4. Sub-processors
4.1 The Customer authorises FleetOS to engage sub-processors to provide the platform. Current sub-processors:
- **Amazon Web Services** — cloud hosting and storage (Australia).
- **Stripe** — payment processing (account-administrator billing data only; **operator personal information is never sent to Stripe**).
- [DECISION NEEDED: list any error-tracking/email sub-processors, e.g. Sentry, that receive personal information.]
4.2 FleetOS remains responsible for its sub-processors' compliance with this Addendum and will give the Customer reasonable notice of any intended change to sub-processors that process personal information. **[LAWYER TO CONFIRM notice/objection mechanism.]**

## 5. Data subject requests
If FleetOS receives a request directly from an operator, it will not respond directly (beyond acknowledging and redirecting) but will refer the operator to the Customer, since the Customer is the responsible entity. FleetOS's export/erasure tooling enables the Customer to respond itself.

## 6. Audit and information
On reasonable request and no more than [DECISION NEEDED: once per year], FleetOS will make available information reasonably necessary to demonstrate compliance with this Addendum. **[LAWYER TO CONFIRM audit-rights scope — a full on-site audit right is unusual for SaaS at this scale.]**

## 7. Liability
Liability under this Addendum is subject to the limitations in the Terms of Service.

## 8. Precedence
If this Addendum conflicts with the Terms of Service on the handling of personal information, this Addendum prevails to the extent of the conflict.
