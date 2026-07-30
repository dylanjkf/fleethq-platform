# Future Vision (10+ Year Horizon)

## Purpose
Give the platform room to grow into a much bigger idea than "fleet software for couriers," without letting speculative future scope leak into and bloat the current build. Everything here is deliberate future direction — documented so it's not forgotten, not so it's built early.

## Directions worth holding open architecturally now
- **International expansion** — enabled by the Jurisdiction Model (`08-Compliance/Jurisdiction_Model.md`); genuinely additive once Australia is proven.
- **Open Platform / plugin marketplace** (`Open_Platform.md`) — enabled by API-first discipline (`12-API/`) and the permission model; third parties building payroll, accounting, fuel card, and insurance integrations on top of FleetOS rather than FleetOS building every integration itself.
- **Customer-facing tracking product** (`Customer_Portal.md`) — a genuinely separate product decision from fleet-internal FleetOS, not a bolt-on; real-time GPS sharing, delivery photos, and customer notifications belong here if and when it's built, deliberately kept out of the core platform's data-sharing assumptions until then.
- **Asset Intelligence depth** — EV/hydrogen telemetry, digital twins of assets, computer-vision-based inspection (automatically assessing checklist photos for damage severity), predictive maintenance sophisticated enough to schedule parts ordering automatically.
- **Autonomous operational assistance** — an "AI operations manager" that moves from recommending (today's Fleet Intelligence posture) to acting with defined, revocable autonomy in narrow, low-risk areas, only after a long track record of correct recommendations and with a manual override always available. See `AI_Autonomy.md`.
- **Broader hardware ecosystem** — the full Universal Asset Hub concept (attached unit sensors, temperature probes, weight sensors, dashcam integration, digital loading dock integration, automatic weighbridge integration) pursued only alongside a sound hardware distribution partnership.
- **Adjacent verticals** — waste management, bus operators, mining, construction, emergency services, postal — each likely needing its own compliance and workflow nuance layered on the same platform, following the same "modular, configurable" pattern used for Australia-first compliance.
- **White-label / enterprise capability** — allowing a large enterprise or reseller to run FleetOS under their own brand, which the design system's token-based theming approach (`13-UI-UX/Design_System.md`) is meant to make feasible without a UI rebuild.

## Explicit non-goals for the foreseeable future
- Becoming a general-purpose logistics/ERP system unrelated to fleet operations.
- Building proprietary hardware as a primary business line rather than a partnership-based optional revenue stream.
- Any autonomous action that bypasses human confirmation for anything safety, compliance, or cost-significant.

## How to use this file
When a genuinely exciting idea comes up that doesn't fit the current mission (`00-Company/Mission.md`), it belongs here, described honestly, rather than either being dismissed outright or smuggled into the current roadmap. This file should be revisited, not frozen — as the company's actual trajectory becomes clearer, entries here should graduate into `17-Roadmap/` or be retired.
