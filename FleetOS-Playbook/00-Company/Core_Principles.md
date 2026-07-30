# Core Principles

These principles are the constitution behind the constitution — when a spec file doesn't cover a situation, these are what decide it. Every feature, screen, and engineering decision in FleetOS must be able to justify itself against these.

## 1. Simplicity first

The easiest way to complete a task is always the default path. If a workflow requires training, a manual, or a phone call to support to complete for the first time, it has failed this principle. Complexity is allowed to exist for power users behind opt-in configuration — it is never allowed to be the default experience.

## 2. Zero duplicate data

Information is entered once and reused everywhere it's needed. If an operator's license number, an asset's registration, or a customer's address already exists in the system, no workflow should ever ask a human to type it again. This is both a UX principle and a data architecture principle — see `11-Database/`.

## 3. Everything has a timeline

Every asset, operator, attached unit, customer, and job has a permanent, append-only, chronological history. Nothing is ever silently overwritten. If a piece of state changes, a timeline event records what changed, when, and by whom (or by what automation). This is what makes questions like "when did this truck first develop this fault?" answerable by design, not by a support ticket.

## 4. Search before navigation

If a user already knows what they're looking for, they should never have to dig through a menu tree to find it. Universal Search and the Command Bar (see `01-Product/`) exist because remembering where something lives in a menu is friction FleetOS should never impose.

## 5. Offline by default

Every core workflow — pre-start checklists, fault logging, photo capture, job status updates — continues to function with zero connectivity and synchronizes automatically the moment a connection returns. This is not a "nice to have" for remote Australia; it's a correctness requirement. A workflow that silently fails or loses data offline is a bug, not an edge case.

## 6. Modular platform

Companies enable only the modules relevant to how they operate, on top of one shared underlying platform. A single-asset owner-operator and a national logistics company use the same core system — they simply have different modules switched on. Modularity is a licensing and configuration concern, never a forked codebase concern.

## 7. AI enhances, never blocks

Every AI-powered workflow has a manual alternative that works fully if the AI is unavailable, wrong, or turned off. AI (Fleet Intelligence, AI Voice, predictive maintenance) makes the platform smarter — it is never a single point of failure for a core operational task.

## 8. Company configurable

FleetOS adapts to how a business already operates rather than forcing the business to change its processes to fit the software. This shows up concretely in the permissions system (fully custom roles, not fixed ones — see `14-Security/`), in configurable checklists and forms, and in flexible workflows rather than rigid ones.

## 9. Universal asset support

The platform is designed to work with any commercial asset — any manufacturer, any size, any age, and eventually any mode of transport (land, air, sea; see `02-Architecture/Asset_Class_Model.md`) — rather than being built around one specific asset type. Only Land is implemented today, but terminology ("Asset," not "Asset"; "Operator," not "Operator") and core abstractions are kept generic on purpose so this isn't a rename-and-rebuild later. Hardware and telemetry integration (`03-Hardware/`) is designed around a pluggable adapter model — OBD/CAN for Land today — rather than a single proprietary or protocol-specific dependency.

## 10. Built for scale

Whether managing a single van or a national fleet of hundreds of thousands of assets, the platform stays fast, reliable, and intuitive. No architectural decision is allowed to assume a small customer — scale is a day-one design constraint, not something addressed later.

## 11. Australia first, global-ready

Every jurisdiction-specific rule (compliance, tax, terminology) lives behind an abstraction rather than being hardcoded throughout the platform. Australia is the only jurisdiction implemented at launch; the platform is architected so a second jurisdiction is a configuration effort, not a rewrite.

## 12. Software is the business; hardware is optional

FleetOS is a software company first. Any hardware relationship (tablet supply agreements, asset hub distribution) exists to remove friction for customers and, where commercially sound, generate additional revenue — it is never a dependency the core software relies on to function.

## How these principles get used

When a new feature spec is written, it should be checked against this list explicitly. When Claude Code (or any engineer) faces an ambiguous implementation choice not covered by a specific document, these principles — in this order of primacy where they conflict — are the tiebreaker.
