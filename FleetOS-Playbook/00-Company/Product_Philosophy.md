# Product Philosophy

## Start with philosophy, not a feature list

Most fleet software starts with a feature list and works backward into a philosophy, if it ever arrives at one. FleetOS does the opposite. Every feature in this repository must be able to answer one question honestly:

> **Does this make someone's actual workday easier?**

Not more impressive. Not more advanced. Not more "AI-powered." Easier. A feature that scores well on a spec sheet but doesn't reduce real friction for an operator, dispatcher, mechanic, or manager doesn't belong in FleetOS.

## Build around the workday, not around the asset

Almost every fleet software product is built around the asset: here's the asset record, here's its data, here's its maintenance history. FleetOS is built around the person and their workday instead. Each role's home screen answers one question:

- **Operator** → what does today's run look like, right now?
- **Dispatcher** → what today's problems need my attention, right now?
- **Mechanic** → what needs to be repaired today?
- **Manager** → what is today costing, and what needs a decision?

No one should ever have to hunt through a menu tree to find "the next thing." The system should already be showing it.

## Replace, don't add

FleetOS is judged by what it removes from someone's day, not by what it adds to a features page. The old workflow for something as simple as reporting asset damage often looks like this:

Receive an SMS → open a maps app → call dispatch → fill out paper paperwork → email the paperwork → separately report the damage → call the mechanic → update a physical service book.

Eight steps across five disconnected tools. The FleetOS version: the operator logs in, and everything that needs to happen already happens inside one flow. A feature that doesn't collapse this kind of chain isn't finished — it's just added a ninth tool to the pile.

## Simplicity is the default; power is opt-in

The easiest possible path is always what a new user sees first. Advanced configuration, custom roles, complex reporting, and power-user workflows are all available — but behind deliberate choice, not thrust into the default experience. A small courier company's owner-operator should never feel like they're using "enterprise software." A large logistics operator should never feel like they've outgrown it.

## Every workflow has a manual path

AI is a first-class part of FleetOS (Fleet Intelligence, AI Voice, predictive maintenance), but it enhances rather than gates. If AI is wrong, unavailable, or switched off, the underlying workflow still completes. Nobody's workday should ever be blocked because a model call failed.

## Data has memory; nothing gets lost

Every object in FleetOS — every asset, operator, attached unit, customer, job — has a permanent, connected history. Not just a log file: a genuinely connected memory that can answer questions like "which operators have operated this asset in the last six months" or "which attached units keep getting paired with assets that later develop suspension issues." This connected structure (see `02-Architecture/Fleet_Graph.md`) is a defining differentiator, not an afterthought bolted on top of flat records.

## Platform, not software

Software solves today's problem. A platform creates tomorrow's ecosystem. FleetOS is deliberately built as a platform from day one — modular, API-first, and eventually open to third-party plugins (`10-Integrations/`) — even though the earliest version of the product will look, to a small courier company, like a focused and simple tool. The simplicity the customer experiences and the platform ambition underneath are not in tension; the architecture is what makes both possible at once.

## Honesty about scope

Big ambition does not mean building everything at once. This repository deliberately separates what ships now (`01-Product/`, `17-Roadmap/`) from what's a deliberate future direction (`18-Future/`). Features that sound compelling but don't serve the current customer (small courier companies, Australia, fleet-internal operations) are documented as future direction, not smuggled into the current build. If something doesn't work in practice, it gets removed from the plan rather than defended for the sake of consistency.
