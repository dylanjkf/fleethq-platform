# CLAUDE.md

**Read this file before touching any code in the FleetOS repository.**

This file tells you (Claude Code, or any AI coding agent working on FleetOS) how to behave in this codebase. It is not optional context — it is the operating contract for how work gets done here.

## Commercial priority — READ THIS BEFORE PLANNING ANY WORK (founder directive, 2026-07-22)

This is a standing, founder-set commercial directive and it outranks feature curiosity. It governs *what to build next* until the founder says otherwise. Full statement: `00-Company/Commercial_Priority.md`.

1. **Finish the product before deploying it.** Do NOT prioritise deployment/hosting infrastructure, or a public pilot, ahead of completing the feature set. The founder intends to run his own tests at a company he works for (subject to their agreement — they may decline), and wants the app *feature-complete for its target vertical first*.
2. **Delivery / courier fleets is the target vertical, and it comes first.** Get *everything ticked off for delivery fleets* — a genuinely sellable, complete courier product — before broadening to other fleet types, other verticals, or other FleetOS projects. When choosing what to build next, prefer whatever most completes the end-to-end courier workflow (dispatch → drive → deliver → prove/complete → office visibility) to a sellable standard.
3. **Sequence:** complete the delivery-fleet vertical → start selling to delivery fleets → *then* start other FleetOS projects/verticals.
4. **Keep building.** Momentum on the courier feature set is the goal; don't detour into deployment, new verticals, or speculative platform work until (2) is done.

When a proposed task doesn't serve "make the courier product sellable," flag that it's off-priority and say why, rather than quietly building it.

## What FleetOS is

FleetOS is the operating system for commercial fleets, built Australia-first. It replaces the pile of disconnected tools a transport business currently runs on — paper checklists, SMS threads, phone calls, spreadsheets, a separate maintenance logbook, a separate compliance folder — with one connected platform covering drivers, dispatch, workshop, and fleet management.

The first customer is a small courier company, and the first Asset Class built is **Land**. The architecture must never assume "small," and must never assume "road vehicle" either — it must scale to a fleet of one vehicle or a hundred thousand, and (per `02-Architecture/Asset_Class_Model.md`) must not foreclose future Air and Sea Asset Classes.

## Terminology — use these terms, not the road-specific ones

This codebase uses generalized terminology so multi-modal expansion (`18-Future/Multi_Modal_Expansion.md`) doesn't require a rename later:

- **Asset**, not "Vehicle"
- **Operator**, not "Driver"
- **Attached Unit**, not "Trailer"

Only Land Asset Class behavior is implemented right now, but the naming throughout code, APIs, and UI copy should already be generic. Do not introduce "Vehicle," "Driver," or "Trailer" into new code, schema, or API contracts.

Full context: `00-Company/Vision.md`, `00-Company/Mission.md`, `01-Product/Product_Overview.md`.

## Authority order

When something is unclear or you're about to make a judgment call, resolve it in this order:

1. **This repository** (the Playbook). If a spec file answers the question, follow it exactly.
2. **Core_Principles.md** (`00-Company/Core_Principles.md`). If no spec file covers the situation, these principles tell you how FleetOS would think about it.
3. **Ask, don't assume.** If neither of the above resolves it and the decision is consequential (data model, permissions, anything user-facing), stop and ask rather than guessing. A wrong guess baked into code is more expensive than a delay.

Never silently override something written in this repository because you think you know better. If you believe a spec is wrong, say so explicitly and propose the change — don't just build something different.

## Non-negotiable engineering principles

These apply regardless of what feature you're building:

- **Offline-first, always.** Every core driver and workshop workflow must function with zero connectivity and sync automatically when connectivity returns. If you're building a feature that silently fails offline, it isn't done.
- **Zero duplicate data entry.** If a piece of information already exists anywhere in the system, the correct behavior is to reference it, not ask the user to type it again.
- **Every entity has a timeline.** Vehicles, drivers, trailers, jobs, customers — anything with an ID gets an immutable, append-only history. Don't design a feature that mutates state without leaving a timeline event behind.
- **Permissions are granular, not role-based.** Never hardcode "if role === admin." Every capability is its own permission (see `14-Security/Permissions_Model.md`), and roles are just named bundles of permissions that a company can edit or clone.
- **AI enhances, never blocks.** Any AI-powered workflow (Fleet Intelligence, AI Voice, predictive maintenance) must have a manual path that fully works if the AI component is wrong, unavailable, or disabled. Never make an AI call a hard dependency for a core workflow to complete.
- **Australia first, international-ready.** Compliance logic (fatigue rules, mass limits, registration types) must live behind a jurisdiction abstraction, not be hardcoded to Australian rules throughout the codebase. Australia is the only jurisdiction implemented at launch, but nothing should assume it's the only one that will ever exist.
- **API-first.** Every capability in FleetHQ or DriverOS should be reachable through the same API a third-party integration or plugin would use. There is no "internal-only" shortcut API.

## What NOT to build right now

To keep scope honest, the following are explicitly out of scope until the roadmap says otherwise (see `17-Roadmap/` and `18-Future/`):

- Customer-facing tracking portals, real-time customer GPS sharing, or customer photo/proof-of-delivery sharing. FleetOS is fleet-internal software for now.
- Any jurisdiction's compliance rules other than Australia's.
- Owned/proprietary hardware as a required dependency. Assume BYO Android tablets connected to a vehicle hub over the vehicle's OBD/CAN port.
- Login mechanisms beyond company-issued username and password (no NFC, QR, or biometric login in v1).

If a request seems to require one of these, flag it rather than quietly implementing a workaround.

## Documentation discipline

If you build something that isn't yet described in this repository, or that changes what's described here, update the relevant Markdown file(s) in the same body of work — don't let the code and the constitution drift apart. Add a line to `CHANGELOG.md` describing what changed and why.

## When you're unsure this file is enough

It usually won't be, on its own — that's what the rest of the repository is for. Check the numbered folder that matches what you're building (`04-DriverOS/`, `05-Dispatch/`, `08-Compliance/`, etc.) before writing code, the same way you'd check a design doc before implementing a feature at any well-run engineering org.
