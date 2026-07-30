# Fleet Intelligence — Overview

## Purpose
Fleet Intelligence is FleetOS's AI layer, spanning the whole platform rather than existing as a separate chatbot. It exists to make existing workflows smarter — never to gatekeep them. Per Core Principle 7 ("AI enhances, never blocks"), every capability described here has a manual, fully-functional fallback.

## Scope
Fleet Intelligence covers, at this phase:
- **Natural-language search resolution** (`01-Product/Universal_Search.md`)
- **AI Voice** hands-free commands (`09-AI/AI_Voice.md`)
- **Predictive maintenance signals** — surfacing likely-upcoming issues from OBD/CAN + fault + Fleet Graph patterns (e.g. "3 assets sharing this attached unit have developed the same suspension issue")
- **Document/photo analysis** — assisted metadata extraction for Digital Glovebox uploads, assisted damage assessment from Smart Checklist photos (always with manual override)
- **Operational recommendations** — e.g. flagging which asset is best suited for a job, or which maintenance should be prioritized next week, surfaced as suggestions, never automatic actions, in v1

## Explicitly not in scope yet
- Autonomous decision-making that acts without a human confirming (e.g. auto-assigning jobs, auto-approving maintenance spend). Fleet Intelligence recommends; a permitted human confirms.
- Cross-customer pattern learning. All Fleet Intelligence in this phase operates within a single company's data boundary — no data or inferred pattern is shared across companies.

## Technical considerations
- Every Fleet Intelligence feature must degrade to a working non-AI path if the model is unavailable, wrong, or the company has it disabled. This is tested explicitly (see `15-Testing/`).
- Fleet Intelligence reads from the Fleet Graph and Timelines as its data source — it does not maintain a shadow copy of fleet state.

## Acceptance criteria
- Every AI-touched workflow in the product has a documented manual fallback path, verified in that feature's own spec file.
- No Fleet Intelligence output is irreversible or auto-executed without human confirmation in this phase.

## Future expansion notes
- The path toward more autonomous "AI operations manager" behavior (per early brainstorming: "which truck should take this job," run automatically) is a deliberate future direction, not a v1 capability — see `18-Future/AI_Autonomy.md`.

## Implementation notes (Predictive maintenance signals, `apps/api` + `apps/fleethq`)
- **Built**: this doc's "predictive maintenance signals" line, as a deterministic pattern detector with **no AI/ML model anywhere in it** — not a stand-in for one, but the working non-AI core that Core Principle 7 ("AI enhances, never blocks") requires to exist before any AI enhancement sits on top of it. Two signal types, both computed at read time from data that already exists (nothing new is stored): `RECURRING_FAULT` (an asset has had the same fault title 2+ times in the last 180 days) and `SHARED_ATTACHED_UNIT_PATTERN` — this doc's own named example ("3 assets sharing this attached unit have developed the same suspension issue") and `01-Product/Fleet_Graph.md`'s own named multi-hop query, flagged unbuilt in that doc's implementation notes until now: 2+ assets that have shared an attached unit (via `graph_relationships` `PAIRED_WITH`) each developed a matching-title fault **after** that specific pairing began (a fault predating the pairing doesn't count — see the e2e test exercising exactly that boundary).
- **OBD/CAN is not a data source here** — this doc names "OBD/CAN + fault + Fleet Graph patterns" together, but no hardware integration exists (`03-Hardware/OBD_CAN_Integration.md`), so only the fault + Fleet Graph half is built. This codebase never fakes a data source that doesn't exist; a real OBD/CAN-derived signal is a distinct, larger, hardware-dependent slice for later.
- **Fault matching is exact-title, not fuzzy** — "recurring" and "shared" both key off an identical `MaintenanceJob.title` string (checklist-triggered faults already have a stable, repeatable title like "Checklist fault: Tyres undamaged"; manually-logged faults need the same title typed twice to match). No text-similarity/NLP matching — a genuinely simple, deterministic, testable rule per this doc's own reasoning for why the fatigue rule check is deterministic, applied the same way here.
- **`GET /v1/predictive-maintenance/signals`**, gated on the existing `maintenance:view` permission (surfacing a pattern over maintenance data is the same capability as viewing that data, not a new one) — no new permission added.
- **FleetHQ**: a "Signals" tab on the Maintenance page (mirroring Compliance's "Fatigue" tab), listing every current signal with its own icon per type and a badge count. Recommendations only, never automatic action — nothing here creates a maintenance job, reassigns anything, or blocks dispatch; a human decides what to do with a flagged pattern, per this doc's own "recommends; a permitted human confirms" requirement.
- **Deliberately not built** (at the time this note was first written; see the Operational recommendations note below for what has since closed this gap): an "operational recommendations" layer (which asset is best suited for a job, what to prioritize next week) — a distinct line in this doc's Scope — and any UI action to jump from a signal straight to logging a follow-up maintenance job (still a reasonable next increment, still not built in this slice).

## Implementation notes (AI Voice, `apps/driveros`)
- **Built**: this doc's "AI Voice hands-free commands" line, all five v1 commands, using the browser's own native Web Speech API for speech-to-text and speech synthesis — no LLM/model call anywhere, the same "deterministic core before any AI enhancement" pattern this doc's own predictive-maintenance and fatigue implementation notes already established. See `09-AI/AI_Voice.md`'s own implementation notes for the full detail, including the one thing this sandboxed environment genuinely cannot verify (real microphone speech recognition) versus everything it did verify live (the full command pipeline via a scripted fake `SpeechRecognition`).

## Implementation notes (Operational recommendations, `apps/api` + `apps/fleethq`)
- **Built**: this doc's "operational recommendations" line, both named examples, as two deterministic rankings — again **no AI/ML model**, the same non-AI-core-first pattern as every other Fleet Intelligence slice in this doc. `GET /v1/operational-recommendations/assets-for-job` ranks active assets for a job assignment starting from the same Fleet Health score (`01-Product/Fleet_Health.md`'s open-fault + compliance-expiry factors) and applying a penalty if the asset is already assigned to a different currently-open job (`?excludeJobId=` exempts the job being edited from penalizing its own already-assigned asset). `GET /v1/operational-recommendations/maintenance-priority` ranks currently-open maintenance jobs by severity first, then age (capped at 30 days so an old Normal fault can't outrank a fresh Critical one forever), then whether the asset is currently tied to an open job. Both are read-only, permission-gated on the existing `dispatch:view` and `maintenance:view` (the same capability as viewing that data, aggregated differently — no new permission), and return `reasons: string[]` explaining the score so the suggestion is legible, not a black box.
- **FleetHQ**: the Dispatch "Assign" dialog's asset picker is reordered by this ranking (highest first) and marks the top non-busy asset "Suggested — best available match for this job" with a sparkle icon; the existing open-critical-fault warning is unchanged and can co-occur with a suggestion on a different asset. The Maintenance page's Jobs tab gained a "Priority" column (score + a title-attribute tooltip of the reasons) and now sorts non-terminal jobs by that score, with completed jobs (which the priority endpoint excludes) staying at the end in their original order.
- **Suggestions only, never automatic**: nothing here assigns a job, reprioritizes a job's status, or blocks a dispatcher/workshop staff from picking any other asset or job — a human reads the ranking and decides, per this doc's Explicitly-not-in-scope-yet section and Core Principle 7.
- **Deliberately not built**: no scheduling/ETA-aware assignment (e.g. accounting for an asset's current job's remaining duration) and no cross-fleet or cross-depot weighting — the ranking only considers the same-company data Fleet Health and the maintenance table already expose. A reasonable future increment, not attempted here.
