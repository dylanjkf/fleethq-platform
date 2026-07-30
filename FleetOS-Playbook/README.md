# FleetOS Playbook

> The single source of truth for the design, engineering, and long-term direction of FleetOS.

## What this is

This repository is not a wiki, a brainstorm, or a pitch deck. It is the **constitution** for FleetOS: the document set that every feature, screen, API, schema, and engineering decision must be judged against. When there's a disagreement about how something should work — in a planning meeting, in a pull request, or inside an AI coding session — this repository wins.

It is written so that:

- A new senior engineer can read it and start contributing in a day, with minimal ambiguity.
- Claude Code (or any other AI coding agent) can use it as grounding context and stop guessing at product intent.
- Product decisions make the roadmap coherent instead of a pile of good ideas that don't fit together.

## How to use this repository

**If you are a human engineer or PM:** start with `00-Company/`, then `01-Product/`, then drill into whichever numbered folder matches what you're building. Every spec file follows the same shape (see "Document standard" below) so you always know where to find acceptance criteria and edge cases.

**If you are Claude Code:** read `CLAUDE.md` first, always. It tells you how to behave in this codebase, which files are authoritative, and what to do when a request conflicts with something written here.

**If you are updating this repo:** don't silently contradict an existing file. If a decision has changed, edit the file, and add an entry to `CHANGELOG.md` explaining what changed and why. Treat this repo with the same rigor as production code — it goes through review too.

## Repository structure

```
FleetOS-Playbook/
│
├── README.md                 ← you are here
├── CLAUDE.md                 ← rules of engagement for AI coding agents
├── PRODUCT_ROADMAP.md         ← what ships when
├── CHANGELOG.md               ← history of decisions and revisions
│
├── 00-Company/                ← vision, mission, principles, philosophy
├── 01-Product/                ← feature specifications
├── 02-Architecture/           ← system design, service boundaries
├── 03-Hardware/               ← OBD/CAN, telematics devices, in-cab hardware
├── 04-DriverOS/               ← the operator-facing mobile/tablet app
├── 05-Dispatch/                ← dispatch, scheduling, routing
├── 06-Workshop/               ← maintenance, workshop hub, parts
├── 07-FleetHQ/                ← the fleet manager web console
├── 08-Compliance/             ← Australian regulatory requirements (NHVR, Chain of Responsibility, etc.)
├── 09-AI/                     ← Fleet Intelligence, AI Voice, Fleet Knowledge Base
├── 10-Integrations/           ← third-party systems, plugin marketplace
├── 11-Database/               ← schema, data model, migrations strategy
├── 12-API/                    ← API-first architecture, endpoints, versioning
├── 13-UI-UX/                  ← design system, screens, workflows
├── 14-Security/               ← authentication, permissions, data protection
├── 15-Testing/                ← QA strategy, test coverage expectations
├── 16-Deployment/             ← CI/CD, environments, release process
├── 17-Roadmap/                ← phased delivery plan
└── 18-Future/                 ← 10-year expansion thinking
```

## Document standard

Every specification file in this repository (features, screens, systems) follows this structure:

1. **Purpose** — why this exists, in plain language
2. **Requirements** — what it must do
3. **Workflows** — the step-by-step of how a person or system uses it
4. **Edge cases** — what happens when things go wrong or go unusual
5. **Technical considerations** — data, performance, offline behavior, integration points
6. **Acceptance criteria** — how we know it's done and correct
7. **Future expansion notes** — where this is headed, so today's implementation doesn't box in tomorrow's

Files that don't fit this shape (like this README, or philosophy documents) are exempt, but everything under `01-Product/` and the engineering folders should follow it.

## Status

This repository is being built in phases. See `PRODUCT_ROADMAP.md` for what's complete and what's in progress, and `CHANGELOG.md` for the detailed history.

**The delivery/courier vertical is feature-complete** (dispatch → drive → deliver → prove → office visibility, plus compliance, workshop, and fleet-intelligence slices) per `00-Company/Commercial_Priority.md`'s "finish the courier product before selling" directive. Commercial-launch-readiness work is also done: production AWS infrastructure-as-code, backups/DR, monitoring, frontend test suites + CI, load testing, a security self-review, an NHVR fatigue-rules review, a Stripe billing system, and lawyer-review-pending legal drafts (`20-Legal/`). What remains before real customer data goes in is human/external, not code: an independent security pentest, a transport-lawyer sign-off on the compliance engine and legal drafts, and standing up a real production environment with real accounts (AWS, Stripe) — see `PRODUCT_ROADMAP.md`.
