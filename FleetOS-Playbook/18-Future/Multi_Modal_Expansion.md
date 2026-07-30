# Future Direction: Multi-Modal Expansion (Air & Sea)

## Status
Terminology and core data model are generalized *now* (`02-Architecture/Asset_Class_Model.md`) so this expansion is additive later. Actually building Air or Sea support is explicitly future scope — a multi-year undertaking, not a near-term roadmap item.

## Why this is a real expansion, not "more features"
Land, air, and sea commercial operations differ in regulator, telemetry protocol, licensing/certification, fatigue rules, maintenance granularity, and operational time scale. Treated honestly, each Asset Class is closer to "a new compliance and integration module" than "a new feature." See `Asset_Class_Model.md` for the specific abstractions this depends on.

## What Air would require, when pursued
- ARINC/ACARS-style (or equivalent) telemetry adapter.
- ADS-B position adapter.
- CASA (Australia) compliance module: airworthiness directives, maintenance program compliance, Flight and Duty Time Limitations as a fatigue-rule module.
- Pilot licensing/medical certification document types.
- Component/serial-level maintenance tracking (mandatory for aircraft, optional depth for Land).
- Flight-scheduling-appropriate Dispatch UI (slot-based, not "today's route").

## What Sea would require, when pursued
- NMEA (or equivalent) telemetry adapter.
- AIS position adapter.
- AMSA (Australia) compliance module: vessel class/flag-state certification tracking, STCW hours-of-rest as a fatigue-rule module.
- Marine certificate of competency document types for crew.
- Voyage-scale Dispatch UI (multi-day/week operations, crew rostering across a voyage).

## Preconditions before either is built
- Land vertical proven with real customers, per the existing product roadmap.
- Asset Class abstraction (`Asset_Class_Model.md`) validated by the act of actually building Land against it cleanly — if Land-only implementation still leaks Land-specific assumptions into "shared" code, that needs fixing before a second Asset Class is attempted.
- A deliberate go-to-market decision — Air and Sea are different customer segments with different sales motions, not simply "more fleets" using the same courier-company playbook.

## How to use this file
This is aspirational, sequenced, future direction — not a commitment to a timeline. Its purpose is to make sure today's architecture decisions don't quietly foreclose it.
