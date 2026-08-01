# Privacy and Data Protection

## Purpose
FOUNDER_NOTES.md flags this as a distinct legal surface from `08-Compliance/`: that folder covers asset/fleet regulatory compliance (NHVR, CoR, fatigue), not the Australian Privacy Act 1988 obligations that apply to storing operator personal information (names, contact details, licence numbers, medical certificate details, uploaded scans of both). This file gives FleetOS's data model and API a concrete, checkable answer to "what happens when an operator asks to see or delete the personal data we hold about them," before real operator data is ever entered.

## Who is the data controller
FleetOS's customer (the transport company) is the entity legally responsible to its operators under the Privacy Act — FleetOS is the software they use to meet that duty, the same relationship any HR/payroll SaaS has with its customer's employee data. FleetOS's job is to give the company's admins the *tools* to fulfil an operator's access or erasure request themselves, not to adjudicate requests on the company's behalf or to expose these actions to operators directly in v1. There is no direct operator-to-FleetOS legal relationship to design for here.

## Scope (v1)
- **Data export**: an admin can produce a complete, structured dump of the personal data FleetOS holds about a single Operator — profile fields, compliance documents (including licence/medical certificate metadata and the attached scans), checklist submissions, messages, and shift history — in one action, to answer an Australian Privacy Principle 12 (access) request.
- **Data erasure**: an admin can irreversibly erase an Operator's directly-identifying personal information — name, contact details, licence/medical document numbers, and the scanned image files themselves — once that operator has left the company, to answer an APP 11.2 (destroy/de-identify when no longer needed) request.
- **What erasure does NOT touch, and why**: business records the company itself is required or entitled to keep are retained, de-identified rather than deleted, per the "erase or de-identify what you're not required by law to retain" reading of APP 11.2 that governs real-world Privacy Act compliance for businesses with independent record-keeping duties (tax, NHVR, WHS):
  - The Operator row itself is kept (not hard-deleted) so Jobs, Shifts, Checklist submissions, Messages, and Timeline events that reference it don't lose their foreign key or go orphaned — "every entity has a timeline" (`CLAUDE.md`) is a stronger constraint than any one field on that entity.
  - Compliance document *type* and *date* fields (registration/insurance/roadworthy aren't operator-personal, but licence/medical *document type and expiry* are kept for the company's own regulatory recordkeeping) — only the identifying `documentNumber` and the scanned file are erased.
  - Timeline event summaries and Message bodies are free text already written into an append-only history; v1 does not retroactively rewrite them. This is a known, documented limitation (see Future expansion notes), not a silent gap.
  - The linked User identity (login credentials) is untouched by erasure run from one company, because a User can hold memberships at other companies (`14-Security/Permissions_Model.md`'s multi-company model) — one company erasing "their" Operator's data must never affect that same person's access or profile at a different company. `fullName` on the User record is a separate, User-owned field from `fullName` on the company-scoped Operator record for exactly this reason.

## Requirements
- Erasure is only available once the Operator is archived (offboarded) — see `01-Product/Onboarding_Decommissioning.md`'s decommissioning process, of which this is one step, never the whole thing.
- Export and erasure are each their own granular permission (`privacy:export_data`, `privacy:erase_data`), per the "permissions are granular, not role-based" principle — an office admin able to view an operator's profile is not automatically able to export or destroy their personal data.
- Erasure produces a Timeline event on the Operator (`personal_data_erased`) recording that it happened and who did it, without repeating any of the erased content — the fact of erasure is itself an auditable business event, even though its payload can't be.
- Erasure is irreversible and the API must say so before acting — there is no "undo" for destroyed scan files.

## Edge cases
- An Operator with no linked User (no DriverOS login, office-managed profile only): erasure proceeds normally: there's no cross-company identity to protect.
- An Operator whose compliance documents are shared with an Asset (a document with both `assetId` and `operatorId`): not possible today — `ComplianceDocument` is always exactly one or the other (see the imports e2e test's dry-run note), so no document erasure can ever affect an Asset's own compliance record.
- Attempting to erase an operator who is not yet archived: rejected — "still employed" and "personal data no longer needed" are contradictory by definition.
- Attempting to erase an already-erased operator: idempotent no-op (same shape as every other archive-style action in this codebase), not an error.

## Technical considerations
- Attachment bytes (the licence/medical scan itself) are zeroed and the filename replaced with a tombstone value rather than deleting the `Attachment` row outright, so the `ComplianceDocument.fileAttachmentId` foreign key never dangles and a download attempt after erasure gets a clear "this file was erased" response instead of a broken link. When a scan is stored in S3 rather than inline in Postgres (see `AttachmentStorage` / `ATTACHMENTS_BUCKET`), erasure **also deletes the S3 object and clears the row's `storageKey`** — otherwise the actual file would survive in the bucket, which would be an erasure that didn't erase. The S3 delete runs **only after the database transaction commits**: deleting the object first would leave the still-referenced DB row pointing at bytes that no longer exist if the transaction then rolled back, so the erasure would have corrupted a live record instead of redacting it.
- No physical delete anywhere in this feature — consistent with `11-Database/Data_Model.md`'s "no hard deletes on entities with Timeline relevance," erasure is a targeted field-level redaction, not a row deletion.
- **Live location is personal information too.** Once DriverOS began reporting an operator's device position (`Operator.last_lat/last_lng/last_location_at`, see `05-Dispatch/Dispatch_Overview.md`), that became directly-identifying data about where a person was. Export includes the last-known position; erasure clears all three columns alongside name/contact — an erased operator's whereabouts must not linger. Only the *latest* fix is ever stored (no breadcrumb trail), so there is no operator location history to sweep. The `gps_pings` breadcrumb table is deliberately **not** touched by erasure, and this is correct rather than a gap: a `GpsPing` references a `GpsDevice` on an *Asset*, with no operator link, and neither the device nor the shift model carries the asset↔operator↔time-window association needed to attribute a ping to one person. A vehicle's trail is the company's operational record of that asset, contributed to by every operator who ever drove it; bulk-deleting it on one operator's erasure request would destroy other data subjects' movements and the asset's own history. It is asset telemetry, not the erased operator's personal data.

## Acceptance criteria
- An admin with `privacy:export_data` can retrieve one JSON document containing everything FleetOS holds about a named Operator.
- An admin with `privacy:erase_data` can erase an archived Operator's name, contact details, licence/medical document numbers, and scanned files in one action; attempting the same on a still-active Operator is rejected.
- After erasure, the Operator's Jobs/Shifts/Checklist submissions/Timeline entries still resolve and display without error — only the identifying fields are gone, not the records that reference the Operator.

## Future expansion notes
- Redacting an operator's name out of historical free-text Timeline summaries and Message bodies is a real future improvement (would need a "find and replace across immutable history" mechanism that doesn't exist yet) — flagged here rather than silently left undone.
- If FleetOS ever needs a direct operator-facing "download/delete my data" self-service flow (rather than admin-initiated), that's a distinct, larger feature — this spec only covers the admin-initiated path a company uses to fulfil its own obligations today.
- A company-wide data export/deletion path (e.g. an entire company closing its FleetOS account) is out of scope here — this file is about one Operator's personal data, not full account offboarding.

## Implementation notes (`apps/api`)
- `PrivacyModule` (`operators/:id/data-export`, `operators/:id/erase-personal-data`) reuses `OperatorsService`/`ComplianceService`/`AttachmentsService` rather than duplicating their query logic — the export bundle is a read-only join across data these services already expose.
- Added `privacy:export_data` and `privacy:erase_data` to the permission catalog under a new "Privacy" category.
