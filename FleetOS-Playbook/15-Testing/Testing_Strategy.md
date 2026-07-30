# Testing Strategy

## Purpose
Make sure the principles in this repository are actually verified, not just aspirational — especially offline-first correctness and permission enforcement, which are the two areas most likely to quietly break as the product grows.

## Required test coverage areas
- **Offline/sync correctness**: every core DriverOS workflow (checklist, fault report, messaging) must have automated tests simulating connectivity loss mid-workflow and verifying no data loss and correct sync-on-reconnect behavior.
- **Permission enforcement**: automated tests verifying that API endpoints reject unauthorized actions regardless of what a client UI would show — this should be tested at the API layer directly, not only through UI-driven tests.
- **AI fallback behavior**: every Fleet Intelligence-touched feature must have a test verifying the manual/non-AI path still fully functions when the AI component is disabled or returns an error.
- **Multi-tenant isolation**: automated tests verifying no company's data is reachable through another company's queries/tokens.
- **Compliance rule correctness**: fatigue/hours and expiry logic tested as pure business rules, independent of UI, given the legal/audit stakes of getting these wrong.

## Testing pyramid (practical, not dogmatic)
Unit tests for business logic (compliance rules, permission resolution, Fleet Graph query logic); integration tests for API contract correctness (`12-API/`); a lean set of end-to-end tests covering the core "10 minutes to first value" flows on both DriverOS and FleetHQ, kept small and stable rather than exhaustive and brittle.

## Acceptance criteria
- No feature is considered "done" (per each spec file's own acceptance criteria) without corresponding automated coverage for offline behavior (where relevant), permission enforcement, and AI fallback (where relevant).
- CI blocks merges that reduce coverage in the four required areas above.

## Future expansion notes
- Load/scale testing against "hundreds of thousands of assets" scale becomes a priority once real customer growth trends warrant it — premature at the small-courier-company launch stage, but the architecture (`02-Architecture/`) is deliberately built so this testing has something meaningful to test against later.
