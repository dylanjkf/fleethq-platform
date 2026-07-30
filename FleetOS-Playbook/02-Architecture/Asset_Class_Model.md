# Asset Class Model

## Purpose
Make multi-modal expansion (land, air, sea) architecturally possible without a rewrite, the same way the Jurisdiction Model makes international expansion possible. This is a deliberate decision made early, while the codebase is small, because renaming core concepts later — after screens, APIs, and customer habits are built around road-vehicle terminology — is far more expensive than deciding the terminology now.

## Core decision: generalize terminology now, build land only for now
Effective immediately across this repository and the platform:
- **"Vehicle" → "Asset"** (a truck, van, aircraft, or vessel are all Assets)
- **"Driver" → "Operator"** (a driver, pilot, or vessel captain/crew member are all Operators)
- **"Trailer" → "Attached Unit"** (a trailer today; could be other towed/attached equipment later)

Only the **Land** Asset Class is actually implemented at launch. Air and Sea are recognized as future Asset Classes in the data model's shape, not built.

## Requirements
- Every Asset belongs to exactly one **Asset Class** (Land, Air, Sea at the model level — only Land populated with real behavior at launch).
- Asset Class is a second, independent axis from Jurisdiction (`08-Compliance/Jurisdiction_Model.md`). Compliance, fatigue/rest rules, and licensing requirements are resolved by the combination of **Asset Class × Jurisdiction** (e.g. Land × Australia = NHVR rules; a future Air × Australia would resolve to CASA rules), never by Jurisdiction alone.
- **Telemetry ingestion is a pluggable adapter per Asset Class.** OBD/CAN is the Land adapter. The ingestion service defines a normalized internal telemetry shape (as already planned in `03-Hardware/OBD_CAN_Integration.md`) that any adapter — OBD/CAN, or a future NMEA (marine) or ARINC/ACARS-style (aviation) adapter — produces, so the rest of the platform never needs to know which protocol an Asset's data came from.
- **Position source is abstracted** the same way (GPS today; AIS/ADS-B are future adapters producing the same normalized position/timeline data).
- **Digital Glovebox document types are configurable per Asset Class**, not a fixed road-vehicle list (registration/insurance/roadworthy today; airworthiness certificates or vessel class certificates are future document types under the same underlying structure).
- **Operator certification is configurable per Asset Class** (driver's licence today; pilot's licence or marine certificate of competency are future certification types under the same underlying Operator-document structure Digital Glovebox already provides).
- **Fatigue/rest-rule engines are pluggable per Asset Class × Jurisdiction**, not just per Jurisdiction — NHVR fatigue rules (Land × Australia) today; Flight and Duty Time Limitations or STCW hours-of-rest are future rule sets under the same engine shape described in `08-Compliance/Australian_Compliance.md`.
- **Fleet Graph supports component-level sub-assets** as an extensible concept (an Asset can have tracked components with their own maintenance/lifecycle data) even though Land-vehicle maintenance in v1 only tracks at the whole-Asset level. This avoids a schema change later for aviation's mandatory component/serial-level tracking.
- **Dispatch/job time granularity is not hardcoded to "today."** The underlying model supports operations of varying duration (an hours-long delivery today; a multi-day voyage or scheduled flight later) even though v1's Dispatch UI is built around a single-day operational view appropriate to courier delivery.

## Edge cases
- An Asset Class with no Land-style "Attached Unit" concept (most aircraft) must not force an empty/irrelevant field into the UI — Asset Class determines which related-entity types are even offered, not just which values are valid.
- A future multi-modal company (a logistics business with trucks and a cargo vessel) must be able to see a unified Fleet Graph/Universal Search across both Asset Classes, with mode-appropriate detail once you drill into a specific Asset.

## Acceptance criteria
- No table, API contract, or screen in the current build refers to "Vehicle," "Driver," or "Trailer" by name — all use "Asset," "Operator," and "Attached Unit" (or an equally generic term), even though only Land behavior is implemented.
- Compliance and fatigue rule resolution code takes both Asset Class and Jurisdiction as inputs, never Jurisdiction alone, even with only one Asset Class populated.
- Telemetry and position ingestion both go through an adapter interface, with OBD/CAN and GPS as the only implemented adapters.

## Future expansion notes
- Air and Sea Asset Classes are a genuine multi-year expansion, not a near-term build. This document exists so that when the company is ready to pursue them, the work is "write a new adapter and a new compliance module," not "redesign the platform." See `18-Future/Multi_Modal_Expansion.md`.
