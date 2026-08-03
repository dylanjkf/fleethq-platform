# FleetOS Privacy Policy

> **DRAFT — PENDING AUSTRALIAN LEGAL REVIEW. NOT ENFORCEABLE. DO NOT PUBLISH.**
> Prepared by the engineering team as a starting point for a qualified lawyer, aligned to how FleetOS actually handles data (`14-Security/Privacy_Data_Protection.md`). See `20-Legal/README.md`.

**Entity:** [DECISION NEEDED: full legal entity name] ("FleetOS", "we", "us"), ABN/ACN [placeholder].
This policy explains how we handle personal information in accordance with the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).

## 1. Our two roles, and which this policy covers
FleetOS handles personal information in two distinct capacities:
1. **As the business we deal with directly** — information about our own customers' staff who administer a FleetOS account (names, work emails, login credentials). This policy covers that.
2. **As a processor for our customers** — personal information about a customer's *operators* (drivers/personnel) that the customer enters into the platform. For that data, **our customer is the entity responsible to those individuals under the Privacy Act; we act on the customer's instructions.** How we handle it is governed by our Data Processing Addendum (`Data_Processing_Addendum.DRAFT.md`) and by the customer's own privacy policy. An operator with a question about their data should contact the transport company that employs them, not us.

## 2. What personal information we collect
- **Account and administrator information:** name, business email, phone, username, and password (stored only as a secure hash), and the company you belong to.
- **Operator information (as processor, on our customer's behalf):** operator names, contact details, licence and medical certificate details and scanned documents, shift/work-hours records, checklist submissions, messages, and job history. We collect this only because our customer enters it to run their fleet.
- **Technical information:** we keep structured request logs for security and reliability (with authentication tokens redacted); we use application error tracking (Sentry) and operational metrics provided by our hosting platform. **[LAWYER TO CONFIRM whether any of this constitutes personal information requiring disclosure here.]**
- **Payment information:** billing is handled by Stripe. We do not store card numbers; we store only Stripe's identifiers and a subscription status (see `19-Billing/`).

## 3. How we use personal information
- To provide, secure, support, and improve the platform.
- To administer accounts, subscriptions, and billing.
- To communicate with account administrators about the service.
- To meet our legal obligations and enforce our terms.
We do **not** sell personal information, and we do not use operator personal information for our own purposes beyond providing the service to the customer that controls it.

## 4. Disclosure and where data is stored
4.1 **Hosting and data location:** FleetOS currently runs on managed cloud hosting — Railway (the API and its managed Postgres database) and Vercel (the web front-ends). Our **planned** target environment is Amazon Web Services in the Sydney region (ap-southeast-2), with disaster-recovery snapshot copies in a second Australian region (ap-southeast-4); that AWS environment is **not yet provisioned**. **[LAWYER + FOUNDER TO CONFIRM the actual hosting region and data-residency position of the current providers before this policy is published, and confirm APP 8 is satisfied.]**
4.2 **Sub-processors / service providers:** our hosting providers (currently Railway and Vercel; AWS planned), Stripe (payments — card data only, and only for account administrators, not operators), and Sentry (error tracking) to the extent they process personal information.
4.3 We may disclose personal information where required by law.

## 5. Security
We use row-level database isolation between customers, encryption in transit (TLS) — with stored secrets such as integration credentials additionally encrypted at rest at the application layer (AES-256-GCM), and database/disk-level at-rest encryption provided by our hosting platform's defaults — hashed passwords, per-request rate limiting, audit logging of security-relevant events, and least-privilege access controls. No system is perfectly secure; we maintain reasonable safeguards appropriate to the sensitivity of the data. See `14-Security/` and `02-Architecture/Scaling_And_Enterprise_Readiness.md`. **[LAWYER TO CONFIRM security representations are accurate and not over-stated.]**

## 6. Data breaches
If a data breach likely to result in serious harm occurs, we will act in accordance with the Notifiable Data Breaches scheme under the Privacy Act, including notifying affected parties and the OAIC as required, and (where we act as processor) notifying the affected customer without undue delay so they can meet their own obligations. **[DECISION NEEDED: specific notification timeline commitment, e.g. within 72 hours of becoming aware.]**

## 7. Access, correction, and erasure
7.1 **Account administrators** may access and correct their own information, or contact us to do so.
7.2 **Operators:** because we hold operator data as a processor, access and erasure requests are fulfilled by the employing company using the platform's built-in export and erasure tools (APP 12 access and APP 11.2 destroy/de-identify — see `14-Security/Privacy_Data_Protection.md`). Operators should direct requests to their employer.
7.3 On account termination we make data available for export for a limited period and then delete or de-identify it in line with our terms and the DPA.

## 8. Retention
We retain personal information for as long as needed to provide the service and to meet legal obligations, then delete or de-identify it. Some records are retained in de-identified form where the customer has independent record-keeping duties (tax, NHVR, WHS) — see `14-Security/Privacy_Data_Protection.md`.

## 9. Complaints and contact
To make a privacy enquiry or complaint, contact [DECISION NEEDED: privacy contact / email]. If you are not satisfied with our response, you may complain to the Office of the Australian Information Commissioner (OAIC) at oaic.gov.au.

## 10. Changes
We may update this policy; the current version will always be available at [DECISION NEEDED: URL], with material changes notified to account administrators.
