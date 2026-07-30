# Product Overview

## Positioning

FleetOS is **the operating system for commercial fleets** — Australia-first, built to become the global standard. It is not positioned as fleet management software, dispatch software, or an operator tablet app. Those are all views into one underlying platform. FleetOS does not compete to be the best version of any single existing tool; it replaces the need to run several of them at once.

## The five pillars

FleetOS is made of five parts that share one data platform underneath. A customer may only use two of them at first — that's expected and by design (see "Modular platform" in `Core_Principles.md`).

### 1. DriverOS
The in-asset tablet experience. Built for an operator who is busy, sometimes offline, and should never need training or a manual to use it. Covers login, pre-start checklists, damage/fault reporting, job/route information, messaging, and Digital Glovebox access. See `04-DriverOS/`.

### 2. FleetHQ
The office/web console used by dispatchers, workshop staff, compliance officers, and managers. Covers dispatch, live fleet status, maintenance workflows, compliance tracking, reporting, and administration. See `07-FleetHQ/` and `05-Dispatch/` and `06-Workshop/`.

### 3. Fleet Intelligence
The AI layer, sitting across the whole platform rather than as a separate chatbot product. Covers predictive maintenance signals, natural-language search, voice commands, document/photo analysis, and operational recommendations. Fleet Intelligence enhances every workflow above it and is never a required dependency for a core task to complete. See `09-AI/`.

### 4. Asset Intelligence
The hardware integration layer: OBD/CAN connectivity through a BYO Android tablet plus an asset hub, turning raw engine, fault, and sensor data into information a human can act on. See `03-Hardware/`.

### 5. Open Platform *(future direction)*
The eventual API and plugin ecosystem that lets third parties build on top of FleetOS rather than FleetOS having to build every integration itself. Foundational API-first architecture is a day-one requirement (`12-API/`); the marketplace itself is a deliberate future milestone (`18-Future/`), not part of the initial build.

## What's in scope now

- DriverOS core workflows: login, pre-start/post-trip checklists, fault and damage reporting with photos, job/route visibility, fleet messaging, Digital Glovebox.
- FleetHQ core workflows: dispatch and live fleet view, maintenance and workshop management, compliance tracking (Australia), reporting, company/user/permission administration.
- Universal Search and Command Bar across every object in the platform.
- Fully custom, permission-based roles (not fixed roles) with multi-company support per user.
- Fleet Graph: connected relationships between assets, operators, attached units, jobs, and customers (see `02-Architecture/Fleet_Graph.md`).
- Timelines for every entity in the system.
- Offline-first sync for every core operator and workshop workflow.
- OBD/CAN-based asset data logging, with explicit flagging of anything not obtainable through that channel.
- Fleet Intelligence: natural-language search, AI Voice commands, predictive maintenance signals, and operational recommendations layered on top of the above.
- Australian compliance: NHVR requirements, Chain of Responsibility, fatigue/rest-break rules, registration/insurance/roadworthy tracking — behind a jurisdiction abstraction that anticipates future countries without implementing them yet.

## What's explicitly out of scope for now

These are documented as deliberate future direction, not omissions:

- Customer-facing tracking portals, real-time customer GPS sharing, customer photo/proof-of-delivery visibility, or anything customer-facing at all. FleetOS is fleet-internal software for this phase. See `18-Future/Customer_Portal.md`.
- Any compliance jurisdiction beyond Australia.
- Owned/proprietary hardware as a requirement — the platform assumes BYO Android tablets, with an optional supplier relationship for convenience, never a dependency.
- Login mechanisms beyond company-issued username and password (no NFC/QR/biometric in v1).
- The third-party plugin marketplace itself (the API architecture that will eventually support it is in scope now; the marketplace and revenue-sharing model is not).

## How this repository is organized around the five pillars

| Pillar | Primary folders |
|---|---|
| DriverOS | `04-DriverOS/` |
| FleetHQ | `05-Dispatch/`, `06-Workshop/`, `07-FleetHQ/` |
| Fleet Intelligence | `09-AI/` |
| Asset Intelligence | `03-Hardware/` |
| Open Platform (future) | `12-API/`, `10-Integrations/`, `18-Future/` |
| Shared foundation | `02-Architecture/`, `08-Compliance/`, `11-Database/`, `13-UI-UX/`, `14-Security/` |

## Where the detailed feature specifications live

Every individual feature named in `00-Company/Vision.md` and discussed in earlier planning (Universal Search, Fleet Graph, Digital Glovebox, Smart Checklists, Universal Forms, Fleet Health Score, Asset/Operator/Attached Unit Timelines, AI Voice, Offline architecture, Universal Asset Hub, Modular Permissions) gets its own dedicated specification file, following the standard document structure described in the repository `README.md`, under the relevant numbered folder. Phase 2 of this repository build produces those files.
