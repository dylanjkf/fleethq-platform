# Mission

## Mission statement

To give every commercial fleet — starting with the smallest courier company and scaling to national logistics operators — one connected system that replaces paperwork, phone calls, and disconnected tools with software that makes every workday easier.

## Who we serve first

**Primary initial customer: small courier companies (roughly 5–20 assets).**

This is a deliberate starting point, not a ceiling. Small courier operators feel the cost of scattered tools immediately and directly — the owner is often also the dispatcher, the person chasing paperwork, and the person answering the phone when a customer asks where their delivery is. If FleetOS makes that person's day meaningfully easier, the value is obvious without a long sales cycle.

Every part of the platform, however, is designed against `Core_Principles.md`'s "Built for Scale" principle: nothing about the data model, permissions system, or architecture assumes a small fleet. The same platform that runs a 6-asset courier company must run a 6,000-asset logistics operator without redesign — only additional modules and configuration.

## What "done" looks like for a customer

Finish the sentence the way it's meant to be finished: **within 10 minutes of onboarding, a courier company can log an operator in, run their first pre-start checklist, and see it appear in the office view — without training, without a manual, and without needing their old paper process as a fallback.**

If we removed FleetOS a month later, the thing the business would miss most isn't a specific report or dashboard. It's how much easier the technology made their day-to-day operations — the absence of chasing paper, chasing texts, and chasing phone calls.

## How we measure whether we're succeeding

- **Time-to-first-value**: how fast a new company goes from signup to their first completed real-world workflow (a checklist, a delivery, a maintenance log) inside FleetOS instead of on paper.
- **Tools displaced per customer**: how many previously-separate tools (SMS, paper forms, spreadsheets, logbooks) a company has fully stopped using because FleetOS replaced them.
- **Workflow completion without support**: whether operators and office staff can complete core workflows without needing to call FleetOS support or fall back to the old process.
- **Retention through the "would you miss it" test**: whether, unprompted, customers describe FleetOS as something that changed how easy their day is, not just a system they use.

## Geographic and regulatory scope

Australia first. Every compliance-sensitive part of the platform (`08-Compliance/`) is built against Australian rules — NHVR requirements, Chain of Responsibility, fatigue and rest-break regulation — because getting this right for Australia's regulatory environment and its remote/patchy-connectivity reality is a genuinely hard, valuable problem. The platform is architected so that a second jurisdiction can be added as a configuration, not a rewrite, when the company expands internationally.

## Business model

FleetOS is, first and foremost, a software company. Revenue comes from the platform itself — subscriptions and modules. Hardware (tablets, asset hubs) is never a required dependency: customers use their own Android tablets. If a hardware distribution partnership becomes commercially sound, it's pursued as an additional, optional revenue line — never as something the software depends on to function.

## The horizon

There is no fixed ceiling on what FleetOS becomes. The mission today is disciplined — small courier companies, Australia, core fleet workflows — precisely so that the foundation is solid enough to support the much larger platform described in `18-Future/` without needing to be rebuilt to get there.
