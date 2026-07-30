# Fleet Graph

## Purpose
Most fleet software stores isolated records: an asset table, an operator table, a job table. FleetOS instead treats relationships between entities as first-class data — a connected operational map of the business, not a pile of tables. This is what makes questions like "which operators have operated this asset in the last six months" or "which customers are most exposed if this truck goes out of service" answerable without a custom report.

## Requirements
- Every core entity (asset, operator, attached unit, job, customer, depot, maintenance event, fault, document) exists as a node with typed, directional relationships to other nodes (e.g. `Operator -[OPERATED]-> Asset`, `AttachedUnit -[PAIRED_WITH]-> Asset`, `Job -[DELIVERED_BY]-> Operator`, `Job -[FOR]-> Customer`).
- Relationships carry time bounds (when did this pairing start/end) so historical state is queryable, not just current state.
- The graph must support multi-hop queries: "which attached units have repeatedly been paired with assets that later developed suspension issues" requires traversing attached unit → asset → fault, aggregated across many assets.
- Every entity's Timeline (see `Asset_Timeline.md` etc.) is a view generated from this graph, not a separately maintained log.

## Workflows
- When an operator is assigned to an asset for a shift, a timed `OPERATED` relationship is created automatically — no manual entry.
- When an attached unit is hitched to an asset, a timed `PAIRED_WITH` relationship is created, closed automatically when unhitched (or manually if hitch/unhitch isn't sensor-detected).
- Fleet Intelligence queries the graph directly to answer natural-language questions and to power predictive maintenance signals ("this fault pattern has occurred on 3 assets that share a common attached unit").

## Edge cases
- Missing/undetected unhitch events must not leave a relationship open indefinitely — a workshop or dispatch correction workflow must exist to manually close stale relationships.
- Historical relationship queries must remain correct even after an entity (e.g. a decommissioned attached unit) is archived — archiving must not delete graph history.
- Multi-company boundary: relationships never span across companies unless explicitly modeled (e.g. a subcontracted asset), and query results are always scoped by the querying user's company/permissions.

## Technical considerations
- This is a graph-shaped data problem sitting on top of the primary relational store (see `11-Database/Data_Model.md` for the decision on graph-native vs. relational-modeled-as-graph). The practical implementation must support efficient multi-hop traversal without requiring a full graph database migration on day one if a relational approach with proper indexing can meet performance needs at expected initial scale.
- Must scale from a handful of assets to hundreds of thousands without a redesign — traversal queries need to degrade gracefully (e.g. via pre-computed aggregates for expensive multi-hop questions) rather than timing out.

## Acceptance criteria
- The four example queries in `Vision.md` ("which operators have operated this asset," "which attached units keep pairing with assets that develop suspension issues," "deliveries affected by this fault," "customers most impacted if this truck goes down") are all answerable directly from graph queries, not bespoke one-off reports.
- Relationship history survives entity archiving.

## Future expansion notes
- The Fleet Graph is the foundation for more advanced Fleet Intelligence later (e.g. fleet-wide pattern detection across many customers' anonymized graphs, subject to strict data-boundary rules). Nothing about that future use should be assumed or built now — flagged only as a direction the underlying structure supports.

## Implementation notes (Dispatch milestone, `apps/api`)
- The first workflow's first half is built: assigning a Job to both an Asset and an Operator opens a timed `OPERATED` relationship exactly as this doc's first Workflow describes ("no manual entry"); reassigning, completing, or cancelling the job closes it. `AttachedUnit -[PAIRED_WITH]-> Asset` (the second workflow) is not built yet — no hitch/unhitch action exists, since `AttachedUnit` shipped in this same milestone as CRUD-only.
- `Job -[DELIVERED_BY]-> Operator` and `Job -[FOR]-> Customer` aren't separately modeled as GraphRelationship rows — a Job's `operatorId` column already captures the same fact directly, and no `Customer` entity exists yet. Revisit if/when multi-hop queries actually need to traverse through a relationship row rather than a foreign key.
- `GraphRelationship` has no `jobId` column — open/close is derived by matching the Operator+Asset pair itself. This is a deliberate scope limit, not an oversight: adding job-level provenance to the relationship would be a schema change beyond what this milestone needed.
- No multi-hop query endpoint exists yet — this milestone only proves relationships get *written* correctly; reading them back via a graph-traversal query is unbuilt.

## Implementation notes (read-side + PAIRED_WITH, `apps/api` + `apps/fleethq`)
- **The read side now exists.** `GET /v1/graph/relationships?entityType=&entityId=` is the first endpoint over `graph_relationships` — it answers this doc's own first acceptance-criterion query directly: "which operators have operated this asset" (and its inverse, "which assets has this operator operated"), for either direction of a relationship, resolving the other side's display name and splitting current (`validTo: null`) from past pairings.
- **The second documented workflow is now built too**: `AttachedUnit -[PAIRED_WITH]-> Asset` via `POST /v1/attached-units/:id/hitch` and `/unhitch`. Hitching to a new asset automatically closes the attached unit's previous open pairing (an attached unit can only be hitched to one asset at a time); an asset having several attached units paired to it simultaneously is not constrained on the asset side. `AttachedUnitsService.findAll`/`findOne` now resolve each unit's current pairing (`currentAsset`) in one batched query so FleetHQ's list can show it without an extra round trip per row.
- **New permission**: `fleet_graph:view`, distinct from `attached_units:view`/`assets:view`/`operators:view` — a user able to see an Asset's basic record isn't automatically able to see its relationship history, per the granular-permissions principle. Hitch/unhitch reuse `attached_units:edit` rather than getting a dedicated permission, since pairing is a state change on the attached unit's own record, not a distinct capability like Dispatch's `assign`.
- **What's still NOT built**, deliberately: the "customers most impacted if this truck goes down" example (would need Job→Customer aggregation, arguably a Reports feature built on top of existing Dispatch/Customer data rather than a new GraphRelationship type) — flagged here rather than attempted as a rushed, half-working version.
- **FleetHQ**: a `GraphPanel` drawer (mirroring the existing `TimelinePanel`'s shape) shows current/past relationships, opened via a "Relationships" button on Assets, Operators, and Attached Units rows. Attached Units also gets Hitch/Unhitch row actions and a "Paired with" column. Live-tested in a real browser via Playwright: assigned a job (creating an OPERATED relationship, confirmed visible from the asset's side), hitched an attached unit to an asset (confirmed in the list, the relationships drawer, and reflected correctly after unhitching).

## Implementation notes (multi-hop example query, `apps/api` + `apps/fleethq`)
- **The "which attached units have repeatedly been paired with assets that later developed the same issue" example query is now answered** — built as `09-AI/Fleet_Intelligence_Overview.md`'s predictive maintenance "shared attached-unit pattern" signal (`PredictiveMaintenanceService`), which joins `PAIRED_WITH` relationship history against Maintenance fault data exactly as this doc anticipated. See that doc's own implementation notes for the detection rule (exact-title fault matching, "after this specific pairing began" boundary) and its deliberate exclusions (no OBD/CAN signal, no fuzzy matching).
