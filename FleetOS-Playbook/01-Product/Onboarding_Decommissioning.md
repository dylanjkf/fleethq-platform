# Asset and Operator Onboarding / Decommissioning

## Purpose
FOUNDER_NOTES.md's #6 gap: specs exist for what happens *during* operation (Dispatch, Compliance, Maintenance), but not the concrete step-by-step of bringing a new Asset or Operator into the fleet, or offboarding one that's left — including what happens to their historical Timeline data. This file is that written-down process, using only capabilities that already exist elsewhere in the Playbook (this file introduces no new entity or screen of its own — it's the sequence, not new plumbing).

## Scope (v1)
Land Asset Class only, per `CLAUDE.md`. Covers the two lifecycles independently — an Asset and its Operator are onboarded/decommissioned on separate timelines (an Operator can move between Assets; an Asset can have many Operators over its life), never as a single combined "unit."

## Asset onboarding (step-by-step)
1. **Create the Asset** (`POST /v1/assets`, `assets:create`) — name and Asset Class are the only required fields; everything else is optional and can be filled in later.
2. **Log its compliance documents** (`08-Compliance/Australian_Compliance.md`) — registration, insurance, roadworthy, each with an expiry date, optionally with a scanned photo. Not required to create the Asset, but an Asset with no compliance documents shows as having nothing to track, not as an error.
3. **Attach any Attached Units** (trailers) via `POST /v1/attached-units` and the Asset's own linking, if this Asset tows one.
4. **Ready for Dispatch** — no explicit "activate" step exists or is needed; an unarchived Asset is immediately assignable to a Job the moment it's created.

## Asset decommissioning (step-by-step)
1. **Archive the Asset** (`POST /v1/assets/:id/archive`, `assets:archive`). This is the entire action — there is no separate "decommission" endpoint because an Asset has no login or active session to revoke, unlike an Operator (see below).
2. **What happens automatically**: Dispatch already refuses to assign an archived Asset to a new Job (`JobsService` checks `archivedAt` before accepting an `assetId`) — no manual "don't use this one anymore" communication needed.
3. **What's retained**: every Job, Checklist submission, Maintenance job, and Compliance document that references this Asset keeps working and keeps displaying — "every entity has a timeline" means archiving never touches historical records, only the `archivedAt` flag on the Asset itself.
4. **Compliance documents**: not auto-archived alongside the Asset — a company may still want registration/insurance history visible after decommissioning (e.g. resale, an insurance claim from before decommissioning). Archive them separately via Compliance if desired.

## Operator onboarding (step-by-step)
1. **Create the Operator profile** (`POST /v1/operators`, `operators:create`) — name, optionally email/phone.
2. **Grant a DriverOS login, if this operator needs one** (`POST /v1/operators/:id/link-user`, `users:create`) — reuses the Operator's own `fullName` (never re-typed), creates a brand-new User + CompanyMembership + Role in one action. Office-only operators (dispatchers who never touch DriverOS) can skip this step entirely.
3. **Log licence/medical compliance documents** against the Operator (same Compliance flow as Assets, `documentType: LICENCE` / `MEDICAL_CERTIFICATE`), each with its own expiry.
4. **Ready for Dispatch** — same as Assets, immediately assignable once created.

## Operator decommissioning (step-by-step)
1. **Archive the Operator** (`POST /v1/operators/:id/archive`, `operators:archive`).
2. **What happens automatically**: if this Operator has a linked DriverOS login, archiving it now *also* deactivates that login's `CompanyMembership` in the same action (`OperatorsService.archive()` calls `UsersService.deactivateByUserId()`) — **this is a fix made as part of writing this file down**: before it, archiving an Operator's profile was cosmetic — the same person's login stayed fully active, which contradicts what "decommissioned" has to mean. A no-op if there's no linked login at all.
3. **What's retained**: same principle as Assets — Jobs, Shifts, Checklist submissions, Messages, and Timeline entries referencing this Operator keep resolving and displaying after archiving.
4. **Personal data, if requested**: archiving is not the same as erasing. If the operator (or the company, on their behalf) wants their personal data erased under the Privacy Act, that's a distinct, later step — see `14-Security/Privacy_Data_Protection.md`. Decommissioning alone retains everything; erasure is opt-in and requires the Operator to already be archived first.

## Edge cases
- **The Operator being archived is themselves the company's last administrator** (unlikely in practice — Operators are rarely also granted `roles:edit` + `users:edit`, but not structurally prevented): the automatic login deactivation in step 2 above goes through the same admin-lockout guard as any other membership deactivation (`14-Security/Permissions_Model.md`'s "Known gaps" fix) and is rejected with `ADMIN_LOCKOUT` rather than silently locking the company out. If this happens, reassign the company's administrative role to someone else first, then retry archiving the Operator.
- **Re-onboarding a previously decommissioned Operator**: creating a fresh Operator profile is correct if this is genuinely a new engagement; if it's the same person returning, there's no "reactivate" flow for an Operator today (unlike a User's CompanyMembership, which does support reactivation via `POST /v1/users/link`) — a real gap, flagged rather than silently worked around.
- **An Asset decommissioned mid-Job**: not possible — Dispatch only accepts unarchived Assets at assignment time, and there's no path to archive an Asset that's currently assigned to an in-progress Job without first reassigning or completing that Job.

## Acceptance criteria
- Archiving an Operator with a linked DriverOS login prevents that login from authenticating afterward.
- Archiving an Asset or Operator never removes or corrupts any Job/Checklist/Maintenance/Timeline record that references it.
- Both onboarding sequences require zero duplicate data entry — an Operator's `fullName` used for their DriverOS login is the same value already on their Operator profile, never re-typed.

## Future expansion notes
- An explicit "reactivate a decommissioned Operator" flow (distinct from creating a brand-new profile) is a natural follow-up once real usage shows how often this happens.
- A guided "decommission this operator" wizard in FleetHQ (archive + optionally erase data in one flow, mirroring the existing Guided Setup checklist pattern) is a reasonable UI polish item once the underlying actions above have been used enough to know what order people actually want them presented in.

## Implementation notes (`apps/api`)
- `OperatorsService.archive()` now looks up the Operator's `userId` before archiving and, if set, calls the new `UsersService.deactivateByUserId(companyId, actorUserId, userId)` — a separate call (its own transaction), the same "call another service, don't force one giant transaction" pattern `linkUser()` already used.
- `AdminLockoutGuardService.assertAdminRemains()` was tightened while building this: it now only enforces when the company genuinely *has* an admin right now (some active membership already holds both `roles:edit` and `users:edit`) — a company that never concentrated those two permissions onto one role isn't missing anything this guard restores, so unrelated membership/role changes in that company must never be collaterally blocked by a pre-existing state this specific action didn't create. Caught by this file's own test coverage (`test/operator-decommission.e2e-spec.ts`), not a hypothetical.
