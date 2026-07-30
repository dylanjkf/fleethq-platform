# Universal Search & Command Bar

## Purpose
Nobody should have to remember where something lives in a menu. If a user knows what they're looking for — a truck, an operator, an invoice number, a fault code — they should be able to type it and get there instantly. This is the practical expression of the "Search before navigation" principle.

## Requirements
- One global search entry point, accessible from every screen in FleetOS (DriverOS and FleetHQ), triggered by a visible search icon or `Ctrl+K` / `Cmd+K`.
- Searches across every object type in the platform: assets, operators, attached units, customers, jobs, deliveries, routes, maintenance records, fault codes, service history, registrations, insurance, compliance documents, forms, photos, notes, messages, checklists, fuel records, locations, depots, employees, companies, AI conversations, attachments.
- Natural-language queries must resolve to structured intent, e.g. "trucks due for service next month," "John's last delivery," "which attached unit had a tyre issue," "Volvos with brake faults," "deliveries to Melbourne last Friday."
- The same input also accepts direct commands (the Command Bar mode): "create asset," "start checklist," "log maintenance," "assign operator," "create delivery," "open truck 17," "show today's jobs." Search and action share one input.
- Results are filtered by the searching user's permissions — never surface an object a user isn't allowed to view.
- Results are ranked by relevance and recency, with the most likely match visually distinct from the rest of the list.

## Workflows
1. User opens search (icon tap or `Ctrl+K`) → types a query → sees live-updating grouped results (by object type) as they type.
2. If the query matches a known command pattern ("create...", "start...", "open..."), the top result is the action itself, executable directly from the results list.
3. If the query is ambiguous ("Volvo"), results show all matching object types (assets named/tagged Volvo, a customer called Volvo, etc.) grouped clearly.
4. Selecting a result navigates directly to that object's detail view / timeline, or executes the command.

## Edge cases
- No results: show a clear empty state, and offer the closest command match if one exists ("Did you mean: create asset?").
- Offline: search must still work against locally synced data (see Offline-First Sync); results should indicate if they may be stale.
- Typos and partial matches: fuzzy matching required — "Vovlo" should still surface Volvo-tagged results.
- Cross-company users: results are scoped to the company context the user is currently active in (see Multi-Company Support), never bleeding across companies.

## Technical considerations
- Requires a unified search index spanning all entity types, kept in sync with the primary data store (see `11-Database/`) and rebuildable without downtime.
- Natural-language intent resolution is a Fleet Intelligence capability (`09-AI/`) with a non-AI fallback: literal keyword search still returns correct if less "smart" results if the NLP layer is degraded or unavailable — per "AI enhances, never blocks."
- Must perform acceptably (sub-300ms perceived response) on both DriverOS tablets and FleetHQ web, including on a modest Android device.

## Acceptance criteria
- A user can find any object they have permission to see within one search, without knowing which module it lives in.
- A natural-language query returns a correctly filtered result set for the documented example queries.
- Search functions offline against locally cached data with no crash or blank state.
- No result ever appears for an object the searching user lacks permission to view.

## Future expansion notes
- Voice-driven search/command entry is a natural extension once AI Voice (`09-AI/AI_Voice.md`) matures.
- Saved searches and search-based alerts ("notify me when a Volvo logs a brake fault") are a plausible v2 capability once the underlying Fleet Graph relationships are stable.

## Implementation notes (`apps/api` + `apps/fleethq`)
- Built this doc's own explicitly-allowed "non-AI fallback": `GET /v1/search?q=` does literal, case-insensitive substring matching across Assets, Operators, Attached Units, Customers, Depots, Jobs, Maintenance jobs, and Compliance documents (by document number). Natural-language intent resolution ("trucks due for service next month") is **not** built — that's the Fleet Intelligence layer this doc itself defers to `09-AI/`, same as AI Voice.
- Permission filtering happens per entity type, not per route: the endpoint carries no `@RequirePermission` of its own (searching isn't a capability), but `SearchService` resolves the caller's full permission set once per request and only queries/returns a type if the caller holds its `:view` permission — verified by a tenant-isolation test and a lacks-permission test, not just by inspection.
- Ranking is exact-match > starts-with > contains, alphabetical within a tier — real but simpler than the doc's fuzzy-typo-tolerance requirement ("Vovlo" → Volvo). Typo tolerance would need Postgres's `pg_trgm` extension (a new binary dependency) or an external search index; deliberately deferred rather than adding that dependency for this slice.
- Command Bar mode (typing "create asset" as an action, not a search) is **not** built — this slice is search-only, wired into the existing nav-only `CommandPalette` (Ctrl+K/Cmd+K) so results and page-navigation share one input, but nothing here executes a command.
- FleetHQ only. DriverOS's own "Universal Search" bullet in the v1 roadmap is deliberately not addressed in this slice — an operator's DriverOS screens are already narrow and task-focused (Today, Messages, Checklist, Glovebox, Fault Report, Help) with no per-entity detail views to search *into*; revisit once DriverOS actually needs to search across more than what's already directly in front of the operator.
- Search results navigate to the matched entity's **list page**, not a per-record detail view — no part of FleetHQ has per-entity detail routes yet (Assets/Operators/etc. are all list+dialog, not `/fleet/:id`), so "get me there instantly" means "get me to the right module," not a deep link. Revisit once/if the app gains detail routes.
- Live-tested in a real browser (Playwright against the booted dev server): typing "volvo" surfaces a created Asset grouped under "Assets," typing "dana" surfaces a created Operator grouped under "Operators," and clicking a result navigates to the correct page.
