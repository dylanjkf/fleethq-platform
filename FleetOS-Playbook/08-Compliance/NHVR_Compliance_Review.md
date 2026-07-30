# NHVR / Heavy Vehicle National Law Compliance Review (2026-07-22)

## Status: DRAFT — PENDING TRANSPORT LAWYER REVIEW

**This document is not a legal certification of compliance with the Heavy Vehicle National Law (HVNL), Chain of Responsibility (CoR) obligations, or any other Australian transport regulation.** It is a good-faith, research-informed comparison between what FleetOS's fatigue engine implements today and what public secondary sources describe as the current Standard Hours regime, done as part of getting v1 ready for commercial sale. No one on this engineering team is a qualified transport lawyer. **Before this product (or its marketing) makes any claim of "NHVR compliant" or "HVNL compliant" to a customer, a transport lawyer must review this document against the current primary legislative text** (the Heavy Vehicle (Fatigue Management) National Regulation, and the Heavy Vehicle National Law Act itself) and confirm or correct every number below.

## Why this exists
The founder asked for the fatigue/CoR compliance engine to be reviewed against current Australian transport law before selling FleetOS to real courier companies, where a wrong fatigue-limit number could mean a customer relies on software that tells their driver they're legally fine to keep driving when they aren't — a genuine safety and liability risk, not just a software bug.

## Research method and its limits
Primary legislative sources (austlii.edu.au, legislation.nsw.gov.au, nhvr.gov.au) returned HTTP 403 to this session's automated fetches — likely bot-blocking on those sites, not a claim that they don't contain the right answer. What follows is built from **web search result summaries of secondary sources** (transport-compliance blogs, driver-training sites, and search-engine synopses of the NHVR's own published guidance pages), cross-checked across multiple independent searches for consistency, not read directly from the primary legislative Schedule. Where two or more independent sources agreed on a specific number, it's presented below with moderate confidence; anything single-sourced or unclear is flagged as such. **A lawyer with direct access to the current Heavy Vehicle (Fatigue Management) National Regulation Schedule should treat every number here as "to be confirmed against the primary text," not as settled.**

## What FleetOS's fatigue engine implements today
`apps/api/src/compliance/jurisdiction/au-fatigue-rules.ts` — "AU Standard Hours (solo driver)" — four checks, each evaluated against a trailing window from the current moment:

| # | Rule | Limit implemented | Status |
|---|---|---|---|
| 1 | Maximum work in 24h | 12 hours | Implemented (pre-existing) |
| 2 | Minimum continuous rest in 24h | 7 hours | Implemented (pre-existing) |
| 3 | Maximum work in 7 days | 72 hours | Implemented (pre-existing) |
| 4 | Minimum continuous rest in 7 days | 24 hours | **Added in this review** |

Each has an `ok` / `approaching_limit` (within 60 minutes of the threshold) / `breach` status, feeding the existing Compliance dashboard, Dispatch assign-time warning (with a logged override), and DriverOS's own status card — none of that plumbing changed; only the rule set itself gained a fourth check.

## What the research found is likely also part of the real Standard Hours regime, and is NOT implemented
These are real, named gaps — not vague hedging. Each is a distinct rule the research surfaced that this engine does not check today:

1. **Sub-shift rest-break cadence at 5.5h / 8h / 11h work windows.** Multiple sources describe minor/substantial/severe/critical breach tiers keyed to shorter work windows within a shift (e.g. driving 6h+ within 6¼h, or 8½h+ within 9h, are described as minor breaches), not just the three/four headline 24h/7d limits this engine checks. This is a materially finer-grained rule than "12h work in 24h" and would require modeling within-shift rest-break timing, not just shift start/end totals.
2. **Night rest break definition and cadence.** A "night rest break" is described as specifically 7 continuous hours of stationary rest taken between 10pm and 8am (driver's base time zone), or a 24-continuous-hour break — a stricter, time-of-day-anchored definition than this engine's "any 7 continuous hours, any time of day" check.
3. **4 night rest breaks in every 14 days, 2 of which must be on consecutive days.** A distinct rolling 14-day pattern requirement, not evaluated by this engine at all (which only looks at 24h/7d windows).
4. **Graduated breach severity (minor/substantial/severe/critical).** Real NHVR enforcement reportedly uses a tiered severity system based on how far over a limit a driver is, with different penalties per tier — this engine currently has one binary `breach` status per rule, not a severity gradient.
5. **Basic Fatigue Management (BFM) and Advanced Fatigue Management (AFM)** — alternative accredited schemes with different (generally more permissive) limits than Standard Hours. Not modeled; every company is evaluated against Standard Hours regardless of whether they hold a BFM/AFM accreditation. This was already a known, documented gap before this review (`08-Compliance/Australian_Compliance.md`'s existing implementation notes) and remains one.
6. **Two-up (multi-driver) crewing rules.** Also a pre-existing, documented gap — not addressed by this review.
7. **Multi-jurisdiction / multi-work-diary edge case** named in `Australian_Compliance.md`'s own "Edge cases" section — still unaddressed; every operator is evaluated against one company-level jurisdiction, not per-diary.

## Recommendation for the founder and the reviewing lawyer
- **Do not market this as "guarantees HVNL compliance."** Marketing and any customer-facing copy should describe this as "Standard Hours headline-limit tracking to help spot fatigue risk early," not a compliance guarantee — the gaps above are real and, in several cases (sub-shift rest cadence, night-rest-break patterns), could mean a driver the system reports as `ok` is not actually compliant under the full Schedule.
- **Item 1-3 above (finer rest-break cadence, night-break definition, 14-day pattern) are the highest-priority next additions** if the product is going to make a stronger compliance claim later — they're headline, frequently-cited rules, not obscure edge cases.
- **The manual-override behavior already in place is the right safety net for now**: `Australian_Compliance.md`'s own edge case ("a manager consciously dispatches an operator close to an hours limit... must be permitted... but logged clearly as an overridden warning") means the system was already designed to assist a human decision-maker rather than be the sole source of truth — this review doesn't change that design, it strengthens confidence in what the assistive check itself covers.
- **Commission the lawyer review before any "NHVR compliant" claim reaches a sales conversation or contract.** This document is the input to that review, not a substitute for it.
