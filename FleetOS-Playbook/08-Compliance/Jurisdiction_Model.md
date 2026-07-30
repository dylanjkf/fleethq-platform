# Jurisdiction Model

## Purpose
Make "Australia first, global-ready" a concrete architectural pattern rather than an aspiration. A second country should be addable as configuration and rule authoring, not a rewrite of the compliance service.

## Requirements
- Every compliance rule (fatigue limits, required document types, expiry logic, terminology) is associated with a `jurisdiction` value.
- The compliance service resolves which rule set applies based on a company's configured jurisdiction(s) — a company can, in principle, operate across more than one jurisdiction if it has assets/operators in more than one (not required at launch, but not architecturally precluded).
- "Australia" is the first, and at launch only, implemented jurisdiction module. Its implementation must not leak Australia-specific assumptions (e.g. specific document names, specific hour limits) into shared/core compliance code — those live inside the Australia jurisdiction module.

## Edge cases
- A rule that genuinely has no equivalent in another jurisdiction (or vice versa) must be modeled as present-or-absent per jurisdiction, not force-fit into a one-size-fits-all schema.

## Acceptance criteria
- Core compliance service code contains no hardcoded reference to Australian regulatory specifics (NHVR, CoR, specific hour limits) — all of that lives inside the Australia jurisdiction module and is loaded/configured, not embedded.
- A hypothetical second jurisdiction module could be added and assigned to a company without modifying the core compliance service.

## Future expansion notes
- This is one of the more important "pay it forward" architectural investments in the whole platform — getting this abstraction right early is materially cheaper than retrofitting it once Australia-specific logic has spread through the codebase.
