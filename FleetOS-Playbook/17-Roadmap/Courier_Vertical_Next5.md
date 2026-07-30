# Courier Vertical — The Next 5 Jobs

> Per `00-Company/Commercial_Priority.md` (delivery fleets first). These five
> complete the end-to-end courier loop — dispatch → drive → deliver →
> prove/complete → office visibility — to a demoable, pilot-ready standard.
> Build order below; status tracked in the CHANGELOG as each ships.

1. **File & photo storage (enabler)** — an upload/store capability so a delivery
   can carry a photo/signature, a fault a damage photo, the Glovebox real PDFs.
   Built first because Proof of Delivery depends on it. *v0: bytes stored in
   Postgres, base64-over-JSON upload so it works through the DriverOS offline
   outbox; swap for object storage at deploy time.*

2. **Multi-stop runs + Proof of Delivery** — the core courier loop. A Job carries
   an ordered list of **stops**; the driver completes each stop on DriverOS with
   an outcome (delivered / attempted-failed), recipient name, note, and photo; the
   job status rolls up. Built on a stops model from the start so completion+POD
   and multi-stop share one design (no rework). *Internal capture only — not
   customer-facing proof sharing (see `CLAUDE.md` scope).*

3. **(folded into 2)** — multi-stop and POD share the stops model and ship together.

4. **Notifications** — nothing built stays silent: a failed delivery, a new
   message, an auto-raised checklist fault, a new assignment all raise an in-app
   notification for the right person. Cross-cutting; makes a real pilot usable.

5. **Operational reporting** — the fleet manager's daily view and the sales
   artifact: deliveries completed/failed, pre-start checklist compliance %, open
   workshop jobs, per-driver activity, with a simple export.

After these, the courier vertical is genuinely demoable and pilot-ready — the bar
the commercial directive sets before we deploy.

**Status: all 5 shipped 2026-07-22.** See the CHANGELOG for verification details.

## The next 5, round two (2026-07-22)

Follow-on jobs, same "finish the courier vertical" priority:

1. **Customers & saved addresses** — a fleet-internal address book so a stop
   references a saved customer instead of the office retyping the same
   address every day.
2. **Bulk stop import (manifest CSV)** — upload today's manifest instead of
   adding stops one at a time; matches or creates Customers as it goes.
3. **Proof of Delivery signature capture** — a canvas signature alongside the
   existing POD photo.
4. **Repeat a run (duplicate job)** — one click to clone yesterday's stops
   into a fresh run instead of re-entering the whole manifest.
5. **Stop reorder + DriverOS next-stop focus** — the office can resequence
   pending stops; DriverOS surfaces a prominent "Next stop" instead of a flat
   list.

**Status: all 5 shipped 2026-07-22.** See the CHANGELOG for verification details.
