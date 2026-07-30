# Digital Glovebox

## Purpose
Every asset carries a physical folder of paperwork today: registration, insurance, permits, roadworthy certificates, manuals, emergency contacts. It gets lost, goes out of date, and isn't visible to anyone except whoever's sitting in the cab. The Digital Glovebox is that folder, digitized, always current, and visible to everyone who needs it.

## Requirements
- Per-asset (and per-attached-unit) document store: registration, insurance, permits, roadworthy/inspection certificates, owner's manual, warranty documents, emergency contact card.
- Expiry tracking on every document type that has one (registration, insurance, roadworthy) with automatic alerts to relevant roles before expiry.
- Accessible from both DriverOS (view-only, relevant-to-this-asset documents) and FleetHQ (full management, upload, replace, archive).
- Every document upload/replacement is a Timeline event on the asset.

## Workflows
- Compliance officer uploads a new insurance certificate ahead of expiry → old one is archived (not deleted) → asset's Digital Glovebox and Timeline both update → any workflow that checked insurance status now sees the new expiry date without further action.
- Operator taps Digital Glovebox on DriverOS → sees current registration, insurance, and roadworthy status for the asset they're currently assigned to, plus emergency contacts.

## Edge cases
- Expired document: DriverOS and FleetHQ both surface a clear, non-dismissible warning state on the asset until resolved — this should also feed the Fleet Health Score.
- Document uploaded to wrong asset: must be correctable (move/reassign) without losing the audit trail of the mistake.
- Offline: previously synced documents remain viewable on DriverOS without connectivity.

## Technical considerations
- Documents are files (PDF/image) plus structured metadata (type, issue date, expiry date, issuing authority) — metadata drives the expiry logic, not OCR guesswork, though OCR-assisted metadata extraction on upload is a reasonable Fleet Intelligence assist (with manual override always available).
- Storage needs to support versioning/archiving rather than overwrite-in-place, consistent with "everything has a timeline."

## Acceptance criteria
- Every asset and attached unit has a Digital Glovebox with at least registration, insurance, and roadworthy tracked with expiry alerts.
- No document is ever silently overwritten — replacing a document produces a Timeline event and preserves the prior version.

## Future expansion notes
- Operator-level Digital Glovebox (licence, medical, inductions) is a natural parallel extension — see `01-Product/Operator_Documents.md` (Phase 2 backlog item, not yet written).

## Implementation notes (Digital Glovebox v0 milestone, `apps/api` + `apps/driveros` + `apps/fleethq`)
- **Scoped to the DriverOS view-only slice, reusing existing data — no file storage.** This slice does not implement the full spec's document store (PDF/image upload, versioning, per-attached-unit support, upload-side Timeline events). Instead: `GET /v1/assets/:id/glovebox` (gated on the pre-existing `assets:view`) returns an asset's registration/insurance/roadworthy status by calling `ComplianceService.findAll()` directly — reusing the exact `ComplianceDocument` records and expiry-status computation the Compliance milestone already built, rather than a parallel document model. Emergency contact is a single new `Asset.emergencyContact` free-text column (not a document), editable from FleetHQ's existing Asset edit form.
- **No new permission category.** Gated on `assets:view` alone, with no secondary `compliance:view` check — unlike Fleet Health Score's cross-resource rollup (which summarizes data across a caller's *entire* fleet and so checks the secondary permission explicitly), this endpoint is scoped to one specific asset the caller already has standing to see, the same "no extra check for your own assigned context" precedent Dispatch already established for a Job's nested Asset name.
- **DriverOS**: a new "Digital Glovebox" screen, reached from Today via the same `?assetId=&assetName=` query params Fault Reporting already uses (the current job's asset, not a general picker). Uses the same network-first-then-IndexedDB-cache pattern as Today's job list — verified with a genuinely forced network failure (not just the `navigator.onLine` flag) that it falls back to the last-synced document/contact data.
- **Not built**: file/photo upload for documents (registration PDFs, etc.), per-attached-unit glovebox, upload-triggered Timeline events, expiry alerts to relevant roles, and the "document uploaded to wrong asset" correction workflow. All remain real, named future work per this doc's full spec above.
