# FleetOS security readiness assessment — superseded

> **This document has been superseded.** It was an early (pre-MFA) engineering
> self-assessment whose headline scores (Cyber Essentials 80, ISO 27001 55,
> SOC 2 58) and its "multi-factor authentication is the one Cyber Essentials
> requirement not yet met" conclusion are **no longer accurate**: MFA (TOTP +
> WebAuthn/passkeys, with admin-tier enforcement) has since shipped, and the
> earlier scores also assumed AWS infrastructure (segmented VPC, Secrets Manager,
> CloudWatch/RDS) that **has never been built in this repository**.
>
> The current, maintained readiness assessment lives in
> **[../../compliance/readiness.md](../../compliance/readiness.md)** — scored
> against the control set and documentation that actually exist today
> (approximately Cyber Essentials 93%, ISO 27001 88%, SOC 2 87%). Use that
> document as the single source of truth. This file is retained only so existing
> links do not break, and intentionally carries no scores of its own to avoid a
> second, contradictory set.

For the per-domain control detail, see the numbered documents in this folder
([README](./README.md)) and the compliance package in
[`docs/compliance/`](../../compliance/).
