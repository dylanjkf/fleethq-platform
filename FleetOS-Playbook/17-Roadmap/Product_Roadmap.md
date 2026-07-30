# FleetOS Product Roadmap

## v1 — Launch (small courier companies, Australia)
- DriverOS: login, checklists, Digital Glovebox, fault/damage reporting, messaging, Universal Search.
- FleetHQ: dispatch, workshop, compliance dashboard, fleet registry, basic reporting, admin/permissions.
- Fleet Graph + Timelines across all core entities.
- Offline-first sync for all DriverOS workflows.
- OBD/CAN integration via Asset Hub (BYO tablet), with manual-entry fallback for unequipped assets.
- Fleet Intelligence v1: natural-language search, AI Voice (core command set), predictive maintenance signals, Fleet Health Score.
- Australian compliance: NHVR basics, Chain of Responsibility evidence trail, fatigue/hours tracking, document expiry.

## v1.x — Post-launch hardening
- Expand Role Templates based on real customer feedback.
- Expand AI Voice command vocabulary.
- Parts inventory basics in Workshop.
- Reporting depth (cost trend analysis, uptime reporting).

## v2 — Scale beyond courier segment
- Support for larger fleet types explicitly (mining, construction, waste management, bus operators) — validating that "built for scale" holds beyond the initial segment.
- Deeper route optimization in Dispatch.
- Operator-level Digital Glovebox and operator safety scoring/gamification.
- API-first foundation matured enough to open limited third-party integrations (`10-Integrations/`), ahead of a full marketplace.

## v3 — Platform expansion
- Second compliance jurisdiction (international expansion begins).
- Open Platform / plugin marketplace (`18-Future/Open_Platform.md`).
- Evaluate customer-facing tracking portal as a genuinely separate product decision, not a default extension of fleet-internal FleetOS.

## Ongoing, cross-cutting
- Continued hardware partnership evaluation (never a dependency, always evaluated on its own commercial merits).
- Continued jurisdiction-abstraction discipline as compliance features grow, so international expansion stays additive.

## How this roadmap should be used
Treat each version boundary as a checkpoint to re-validate against `00-Company/Core_Principles.md`, not just a features-shipped list. If a v1.x or v2 idea starts to require compromising offline-first, permission granularity, or the jurisdiction abstraction, that's a signal to slow down and revisit the idea rather than ship around the principle.
