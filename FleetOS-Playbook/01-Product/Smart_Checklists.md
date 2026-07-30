# Smart Checklists

## Purpose
Paper pre-start checklists are static and don't adapt to what's actually found. Smart Checklists replace them with a dynamic flow: what happens next depends on what the operator reports, and the right people are notified automatically instead of the paper form disappearing into a folder.

## Requirements
- Company-configurable checklist templates (per asset type / role), built without code (see Universal Forms for the builder).
- Conditional branching: an answer can trigger follow-up questions, a required photo, a location capture, or an automatic notification/workflow (e.g. "tyre damaged" → photo required → tread measurement required → workshop notified → repair job created).
- Must run fully offline on DriverOS and sync when connectivity returns.
- Every completed checklist becomes a permanent Timeline event on the relevant asset/attached unit and operator.

## Workflows
1. Operator opens today's pre-start checklist on DriverOS.
2. Answers proceed top to bottom; any answer configured to branch immediately reveals its follow-up steps (photo capture, notes, measurement).
3. On submission, any triggered downstream actions fire: workshop notification, maintenance job creation, asset availability flag change.
4. Office (FleetHQ) sees completed/incomplete checklist status for every asset in real time (once synced).

## Edge cases
- Operator starts a checklist offline, loses/regains connectivity mid-flow: progress must persist locally and resume correctly, never losing captured answers or photos.
- Required photo not captured (camera permission denied, hardware issue): checklist cannot be marked complete without it if configured as mandatory — but the operator isn't blocked from continuing their day if the item is downgraded to "reported, photo pending."
- Conflicting branch answers (e.g. contradictory follow-up responses): flagged for office review rather than silently accepted.

## Technical considerations
- Checklist templates are versioned; a change to a template must not retroactively alter previously completed checklists' recorded answers.
- Branching logic is data-driven (defined in the template), not hardcoded per checklist type, so companies can build new checklist types without an engineering change.

## Acceptance criteria
- A "tyre damaged" branch produces, without further manual data entry: a photo attached to the asset record, a workshop notification, and a maintenance job — all from one operator interaction.
- Checklists complete fully offline and sync correctly on reconnect, with no data loss under simulated connectivity drop mid-flow.

## Future expansion notes
- AI-assisted photo analysis (e.g. automatically flagging visible tyre damage severity) is a Fleet Intelligence enhancement layered on top of this — never a requirement for the checklist to function.

## Implementation status (2026-07-16 — Smart Checklists milestone)
This spec is partially built. See `17-Roadmap/Milestone_10_Smart_Checklists.md` and the CHANGELOG for the full scope and reasoning.

**Built**: company-configurable, versioned templates (`ChecklistTemplate`); immutable operator submissions (`ChecklistSubmission`) that run fully offline on DriverOS with mid-flow answer persistence; version snapshotting so a template edit never rewrites a completed checklist; a failed item optionally raising a workshop MaintenanceJob with no further data entry; completed checklists writing Timeline events on the asset and operator; idempotent submit on reconnect.

**Data-driven, but scoped**: `items` is JSON (`pass_fail` / `pass_fail_na`), and the only branching is two per-item booleans — `requireNoteOnFail` and `createsFaultOnFail`. This delivers the "answer drives a required follow-up and an automatic workflow" idea without the full conditional-question-tree engine.

**Not yet built**: the full Universal Forms drag-and-drop builder (a structured item editor stands in); conditional question trees; photo / location / measurement capture; a dedicated notifications system (the auto-created MaintenanceJob is the workshop's queue for now); checklist scheduling/assignment; multi-device concurrent-edit conflict resolution; AI photo analysis.
