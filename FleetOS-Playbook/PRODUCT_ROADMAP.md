<!-- planned-infra-doc -->
> ⚠️ **Planned / target architecture — not yet provisioned.** Parts of this document describe the intended AWS deployment (RDS, KMS, CloudFront, ECS/Fargate, Secrets Manager, and `infra/terraform/*` modules). **That infrastructure does not exist in this repository yet** — a repo-wide search for `infra/terraform` returns only documentation, no `.tf` files. Statements below that read as present-tense fact describe the *target* state; treat them as planned until the Terraform is actually committed. The app currently deploys to Railway (see `api/README.md` and `FleetOS-Playbook/.../Go_Live_Runbook.md`).

# Product Roadmap (Repository Build)

Tracks the build-out of the Playbook itself. For the FleetOS *product* roadmap, see `17-Roadmap/Product_Roadmap.md`.

## Phase 1 — Foundation ✅
README.md, CLAUDE.md, Vision, Mission, Product Philosophy, Core Principles, Product Overview.

## Phase 2 — Product ✅
Universal Search & Command Bar, Fleet Graph, Digital Glovebox, Smart Checklists, Universal Forms, Timelines, Fleet Health Score, Fleet Intelligence overview, AI Voice, Modular Permissions & Custom Roles.

## Phase 3 — Architecture ✅
System Architecture, Universal Asset Hub & hardware strategy, OBD/CAN Integration, Data Model, API-First Architecture, Australian Compliance, Jurisdiction Model.

## Phase 4 — UI/UX ✅
Design System overview, Dispatch overview, Workshop Hub overview, FleetHQ overview, DriverOS overview.

## Phase 5 — Engineering ✅
Testing Strategy, Deployment & CI/CD overview, FleetOS product roadmap.

## Phase 6 — Future ✅
Future Vision (10-year horizon), Customer Portal (deferred), Open Platform / plugin marketplace (deferred).

## Founder Notes ✅
Honest gap analysis and de-scoping recommendations — see `FOUNDER_NOTES.md`.

## What's genuinely still open (see FOUNDER_NOTES.md for why these matter most)
- Data migration / onboarding-from-paper workflow spec
- Cross-cutting Notifications system spec
- Privacy & data protection spec (Australian Privacy Act, distinct from asset compliance)
- ~~Billing & subscription management spec~~ ✅ built — `19-Billing/Billing_And_Subscriptions.md` (Stripe-backed, live-config-only away from production)
- Backup & disaster recovery — 📋 **Planned (spec only, not yet built).** The design (RDS PITR + cross-region snapshot copy, documented RPO/RTO) is written up for `infra/terraform/modules/database/`, but that Terraform does not exist in this repo yet — see the planned-architecture banner at the top of this file.
- Asset/operator onboarding & decommissioning workflow specs
- Support/helpdesk pathway spec

## How to keep building
Each existing spec file follows the standard structure in `README.md`. New spec files (including the open items above) should follow the same structure and get added under the relevant numbered folder, with a `CHANGELOG.md` entry describing what was added and why.

## 2026-07-13 addendum — Multi-modal groundwork

- Added `02-Architecture/Asset_Class_Model.md`: generalizes core terminology (Vehicle→Asset, Driver→Operator, Trailer→Attached Unit) and introduces Asset Class (Land/Air/Sea) as a second abstraction axis alongside Jurisdiction, so future Air/Sea expansion is additive, not a rewrite.
- Added `18-Future/Multi_Modal_Expansion.md`: what Air and Sea would each require, explicitly sequenced after the Land vertical is proven.
- Updated `CLAUDE.md` and `00-Company/Core_Principles.md` to enforce the new terminology going forward.
- Land remains the only Asset Class actually implemented. This is a naming/architecture decision made early because it's cheap now and expensive later — not a scope increase for the current build.
