# ADR 0001 — Code-size and complexity limits are enforced by lint, as a ratchet

- **Status:** Accepted
- **Date:** 2026-07-24
- **Deciders:** Engineering (per the FleetHQ Engineering Constitution)

## Context

The FleetHQ Engineering Constitution sets hard limits on code shape:

| Limit | Threshold |
|-------|-----------|
| File length | 500 lines |
| Function length | 50 lines |
| Nesting depth | 3 |
| Parameters | 5 |
| Cyclomatic complexity | 10 |

Until now these lived only in prose. Nothing enforced them, so a regression
could only be caught by a human reviewer noticing — which does not scale to
"thousands of enterprise customers, maintained for many years."

A one-time audit found the codebase already largely compliant: of ~608 source
files only 4 exceed 500 lines, `any` is near-zero, and no SQL or external calls
leak into the presentation layer. The violations that do exist are concentrated:
in `apps/api`, ~1 oversized file, 7 functions with >5 parameters, 3 with >3
nesting, 40 functions >50 lines, and 27 with complexity >10.

## Decision

Enforce all five limits **in the linters** (ESLint for `apps/api`, oxlint for
`apps/fleethq` and `apps/driveros`) rather than leaving them as prose, and adopt
them as a **ratchet** on the existing healthy codebase rather than a big-bang
refactor:

1. **Every limit starts as `warn`.** It is immediately visible in the IDE and in
   CI (lint already runs in all three CI workflows) and cannot regress silently
   in review, but it does not break the build on pre-existing,
   individually-defensible cases.

2. **`max-params`, `max-depth`, and `max-lines` graduate to `error`** in the
   wave that drives their violation count to zero. These limits are cheap to
   satisfy and unambiguously good: too many parameters becomes an options
   object, deep nesting becomes an early-return or an extracted helper, and a
   1,000-line file has a real seam waiting to be found.

3. **`max-lines-per-function` and `complexity` stay `warn`.** The Constitution
   ranks *"readability over brevity"* and *"simplicity over cleverness"* above
   hitting a line count. Mechanically splitting a linear 55-line function, or an
   11-arm `switch`, into smaller pieces usually *reduces* readability by
   scattering one obvious thing across several indirections. React components are
   the clearest case: a page with 200 lines of JSX is one readable unit, not a
   complexity problem. These two rules are therefore a **guided signal** — a
   prompt to ask "is there a genuine simplification here?" — driven down
   opportunistically when the answer is yes, never satisfied by churn.

4. **Test files are exempt** from the size/complexity limits. Long `describe`/
   `it` blocks and higher branching in fixtures are normal and desirable; the
   limits target production code paths.

## Consequences

- The standards are now automated, not tribal. New code that violates a
  graduated (`error`) limit fails CI; new code that violates a `warn` limit is
  flagged in every lint run and every editor.
- The warning count is a tracked, monotonically-non-increasing number. "Reduce
  warnings" is a always-available, low-risk background task that improves the
  codebase without destabilising it.
- We explicitly accept that some functions and components will remain above 50
  lines / complexity 10 by design. That is a deliberate, documented trade-off in
  favour of readability, not an oversight.
- Promotion of a rule from `warn` to `error` is itself a reviewable, verifiable
  event (the violation count is zero, the linter proves it), which is the kind
  of evidence an ISO 27001 / SOC 2 secure-development review looks for.
