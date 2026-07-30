# Vision

## The one-line version

FleetOS is the operating system for commercial fleets — starting in Australia, built to become the global standard.

## The problem we're eliminating

Transport businesses today run on a pile of disconnected tools that were never designed to work together: paper pre-start checklists, SMS threads between operators and dispatch, phone calls to chase down a delivery status, a separate maintenance logbook, a folder (physical or digital) of compliance documents, a spreadsheet for fuel, another one for costs. None of it talks to each other. Every handoff between an operator, a dispatcher, a mechanic, and a manager loses information or duplicates it.

The problem isn't any single one of these tools. The problem is that a fleet's operations are scattered across all of them at once, and nobody — not the operator, not the office, not the owner — has one place that reflects what's actually happening across the business right now.

## What FleetOS replaces

Not one competitor. All of them, at once, for the business that adopts it:

- Paper checklists and inspection sheets
- SMS and phone-call-based dispatching
- Standalone maintenance logbooks
- Folders of compliance paperwork
- Spreadsheets tracking fuel, costs, and asset status
- Disconnected point solutions that only solve one sliver of the day

## Why "operating system" and not "app"

An app solves one problem. An operating system is the layer everything else runs on top of. We are deliberately not building "a dispatch app" or "an operator app" or "a maintenance app" — we are building one connected platform where the operator experience, the dispatch experience, the workshop experience, and the fleet management experience are different views into the same underlying data, not different products bolted together.

This matters for a concrete reason: when an operator logs a fault, that fault should already exist for the workshop, for the fleet manager's dashboard, and for the asset's permanent timeline, without anyone re-entering it. That's only possible if there's one operating layer underneath, not four separate products with an integration between them.

## Who we start with, and where we're headed

FleetOS starts with small courier companies — businesses that feel the pain of scattered tools acutely and can adopt something new quickly. But the platform is never built as "software for small fleets." Every architectural decision (see `Core_Principles.md` and `02-Architecture/`) assumes the same platform must work identically well for a fleet of one asset and a fleet of a hundred thousand.

We start in Australia because Australian compliance (Chain of Responsibility, NHVR fatigue rules, the realities of remote connectivity) is a genuinely hard problem worth solving well, and solving it well here builds a platform ready to expand internationally without a rewrite.

## What success looks like

A transport business owner installs FleetOS and, within their first day, stops needing the SMS thread, the paper checklist, and the separate maintenance logbook. Within their first month, if you took FleetOS away, the thing they'd miss most isn't a specific feature — it's how much easier their daily working life became. That's the bar every feature in this repository is judged against.

## What we are not

We are not trying to be the most feature-dense fleet software on the market. We are not chasing every telematics data point for its own sake. We are not building a customer-facing tracking product right now — FleetOS is fleet-internal software, full stop, for this phase of the company (see `18-Future/` for where that could go later). Every feature earns its place by making someone's actual workday easier, not by being impressive on a spec sheet.
