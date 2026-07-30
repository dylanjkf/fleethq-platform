# Timelines (Asset, Operator, Attached Unit, Customer, Job, Company)

## Purpose
Every meaningful entity in FleetOS has a permanent, chronological, append-only record of everything that's happened to or involving it. This turns "what happened to this truck" from a support request into something anyone with permission can simply scroll through.

## Requirements
- Every entity type (asset, operator, attached unit, customer, job, maintenance record, and rolled up to company level) has a Timeline view generated from Fleet Graph events — not a manually maintained log.
- Timeline entries include: what happened, when, who/what triggered it (human or automation), and links to any related entity (e.g. a fault event links to the checklist it came from and the workshop job it triggered).
- Timelines are read-only history — nothing in a Timeline is ever edited or deleted; corrections are new entries that reference what they're correcting.
- Filterable by event type (faults only, maintenance only, operator assignments only, etc.) and by date range.

## Workflows
- Fleet manager opens an asset's Timeline and scrolls back to see: start of shift, fuel stop, delivery completion, fault appearance, photo upload, workshop notification, job completion — in order, without cross-referencing four different systems.
- Compliance officer filters an operator's Timeline to fatigue/rest-break events only, ahead of an audit.

## Edge cases
- High-volume entities (an asset with years of history): Timeline must paginate/virtualize rather than load everything at once.
- Entity archived/decommissioned: Timeline remains fully accessible for historical/audit purposes even though the entity itself is no longer active.
- Correction of a mistaken entry: represented as a new Timeline entry referencing the original, never a silent edit.

## Technical considerations
- Timelines are a read model over the Fleet Graph's event history — see `02-Architecture/` for how this is kept performant at scale (likely an event-sourced or append-only log underlying a queryable projection, detailed in the architecture phase).

## Acceptance criteria
- Every core entity type has a working, filterable, chronologically correct Timeline.
- No Timeline entry can be edited or deleted through any part of the product — only appended to or superseded by a new entry.

## Future expansion notes
- Timeline export (e.g. for compliance audits or insurance claims) as a formatted document is a natural, low-risk future feature once core Timelines are stable.
