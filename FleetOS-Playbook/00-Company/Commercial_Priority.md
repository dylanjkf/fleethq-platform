# Commercial Priority — Delivery Fleets First

> **Founder directive, recorded 2026-07-22.** This is a standing commercial
> decision about *what gets built next and in what order*. It is authoritative:
> `CLAUDE.md` points here and every planning decision must respect it until the
> founder changes it. It is recorded in three places (this file, `CLAUDE.md`, and
> the `CHANGELOG.md`) precisely so it does not get lost.

## The directive, in the founder's own framing

- **Finish the app before deploying it.** We are *not* going to stop and stand up
  hosting/deployment infrastructure yet. Deployment is agreed to be the right move
  *eventually*, but not before the product is feature-complete for its target
  vertical. (This overrides the standing engineering instinct to "deploy the
  thinnest slice first" — a deliberate, founder-made trade-off.)
- **The founder will run his own tests first.** The intent is to trial FleetOS at
  a company the founder works for. That company may say no — the plan does not
  depend on their yes, but that is the first intended real-world test.
- **Delivery / courier fleets is the beachhead, and it comes first.** Get
  *everything ticked off for delivery fleets* — a genuinely complete, sellable
  courier product — before broadening to other fleet types (mining, construction,
  waste, bus), other verticals, or other FleetOS projects.
- **Then sell, then expand.** Sequence: complete the delivery-fleet vertical →
  start selling FleetOS to delivery fleets → *then* start other FleetOS projects.
- **Keep building.** Momentum on the courier feature set is the priority.

## What this means for day-to-day prioritisation

When choosing the next task, prefer whatever most advances the **end-to-end
courier workflow to a sellable standard**:

> dispatch a delivery → driver sees their day → driver delivers → proof/completion
> captured → office sees it and can report on it.

Concretely, until the courier vertical is "done enough to sell":

- **Do** build the missing pieces of that loop (job completion & proof of
  delivery, multi-stop runs, notifications so nothing is silent, operational
  reporting a fleet manager would pay for, photo capture, onboarding polish).
- **Defer** anything that doesn't serve it: deployment/hosting, other fleet
  verticals, AI Voice, OBD/CAN telematics, multi-modal (Air/Sea), the full
  NHVR/fatigue compliance engine, and platform/marketplace work — unless a
  specific courier customer need pulls it forward.
- If a proposed task doesn't clearly make the courier product more sellable, say
  so and why, rather than quietly building it.

## Status note

As of this directive, roughly a quarter of the documented v1 is built (see the
CHANGELOG and `17-Roadmap/`). The built work is a solid, tested foundation, but
several pieces of the *courier delivery loop itself* are still missing — those are
now the priority. The immediately-next candidate jobs are tracked from here
forward in the roadmap and CHANGELOG.
