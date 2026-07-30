# Onboarding & Bulk Import

## Purpose
Every other spec in this repository assumes Assets, Operators, and Customers already exist in FleetOS. None of them describe how a courier company with years of paper records and a spreadsheet actually gets started. `FOUNDER_NOTES.md` names this as the single biggest risk to the "10 minutes to first value" mission (`00-Company/Mission.md`) — if getting existing fleet data into the system is painful, nothing else in this repository matters. This spec exists to close that gap.

## Requirements
- A company admin can bring an existing spreadsheet or CSV export of their fleet and operators into FleetOS without retyping every record by hand.
- Every imported record is validated before anything is created — bad rows (missing required fields, an unsupported Asset Class, a malformed email) are flagged individually, never silently dropped and never allowed to block the rows around them.
- An import is a preview-then-commit workflow: an admin sees exactly what will be created, and what will be skipped and why, before anything is written.
- Imported records are indistinguishable from hand-entered ones afterward — same validation rules, same permission checks, same Timeline event on creation. Import is a bulk *input method* for the existing Asset/Operator creation capability, not a separate, parallel path with its own rules.

## Workflows
- A new company admin, mid-signup, uploads a CSV export of their vehicle register. FleetOS shows the parsed columns and lets them map each one to an Asset field (name, external reference, Asset Class). A preview shows 40 valid rows ready to import and 2 flagged rows (one missing a name, one with an Asset Class that isn't Land). The admin fixes the two rows in their own spreadsheet, re-uploads, and commits — all 42 Assets now exist, each with a normal "created" Timeline event.
- The same admin repeats the workflow for their operator roster (name, email, phone).

## Edge cases
- A row that's valid but a near-duplicate of an existing record (same name, different casing): not blocked in this slice — de-duplication is a real future need but requires a fuzzy-matching design decision this spec doesn't make yet (see Future expansion notes).
- A very large file (thousands of rows): the import is bounded (see Technical considerations) rather than accepted and then failing partway through with no clear record of what succeeded.
- A commit that's interrupted partway (e.g. a network drop): already-created rows stay created — commit is not one giant transaction, so an admin can safely re-run the import and rely on re-attempting only the rows that weren't reported as created.

## Technical considerations
- Column mapping and CSV parsing happen client-side (no server-side file upload/storage needed for this slice) — the API receives already-mapped, structured row data, never raw file bytes.
- Row validation on the server reuses the exact same DTOs and service-layer `create()` methods that manual single-record creation already uses, rather than a parallel bulk-specific validation path that could drift from it over time.
- Bounded batch size per request (rather than unbounded) so a single import can't overwhelm a request or silently time out midway.
- Gated by the existing `assets:create` / `operators:create` permissions — importing is bulk creation, not a distinct capability, so no new permission category is introduced for it.

## Acceptance criteria
- A CSV of Assets or Operators can be previewed (validated, nothing written) and then committed (valid rows created, invalid rows individually reported) in two clearly separate steps.
- Every created row produces the same Timeline "created" event a manually-created record would.
- No row's failure prevents any other valid row in the same batch from being created.

## Future expansion notes
- Customer and Depot import, once those entities are modeled (`11-Database/Data_Model.md` still lists them as unmodeled).
- Duplicate detection/merge-on-import, once a real fuzzy-matching approach is designed.
- AI-assisted column mapping (auto-detecting "Rego" → `externalReference`, etc.) is a natural Fleet Intelligence extension once this manual-mapping version is proven — never a hard dependency for import to work, per `CLAUDE.md`'s "AI enhances, never blocks."

## Implementation notes (Import milestone, `apps/api` + `apps/fleethq`)
- Built exactly the scoped slice above: `POST /v1/imports/assets` and `POST /v1/imports/operators`, each accepting `{ rows, dryRun }`. `dryRun: true` validates every row (using the exact same `CreateAssetDto`/`CreateOperatorDto` class-validator rules the single-record endpoints already enforce) and returns per-row pass/fail with no writes. `dryRun: false` (or omitted) re-validates and creates only the valid rows, calling `AssetsService.create()`/`OperatorsService.create()` directly per row rather than duplicating their logic — each success gets the same Timeline "created" event a manual creation would.
- No new permission category — the import endpoints are gated on the pre-existing `assets:create`/`operators:create` permissions, since importing is a bulk application of a capability that already exists, not a new one.
- Batch size capped at 500 rows per request. Commit is not wrapped in a single all-or-nothing transaction — each row is created independently, so a partial failure (or a client disconnect mid-import) never rolls back rows that already succeeded.
- Not built in this slice: Customer/Depot import (unmodeled entities at the time), duplicate detection, and AI-assisted column mapping — all named above as deliberate future work, not oversights.
- **Update (later milestones):** the import surface has since grown well past this original assets/operators slice — `POST /v1/imports/` now also covers **depots**, **customers**, **attached-units**, and **compliance-documents** (once those entities were modelled), each following the exact same `{ rows, dryRun }` shape, per-row validation, and existing-permission gating described above. Duplicate detection and AI-assisted column mapping remain the genuine open future work.

## Bulk file import (`POST /v1/documents/bulk`)

The `{ rows, dryRun }` endpoints above import *records* typed from a spreadsheet.
Importing *files* is the other half of getting an existing business's paperwork
into FleetOS, and it works the same way in the places that matter and differently
where files genuinely differ:

**The same:**
- **Per-file independence.** One unreadable, mislabelled or oversized file
  reports its own error and every other file in the batch is still created. The
  response is the same `ImportResult` shape (`total`/`createdCount`/`rows[]` with
  indexes), so a UI can point at exactly which file failed.
- **No new permission.** Gated on the existing `documents:create` — a bulk upload
  is a bulk application of a capability that already exists.
- **Reuses the single-record path.** Each file is validated with the ordinary
  `CreateDocumentDto` and created through `DocumentsService.create()`, so a
  bulk-uploaded document is identical to a hand-uploaded one.

**Deliberately different:**
- **No `dryRun`.** A dry run exists so someone can check a batch before paying
  the cost of committing it. For a file upload the cost *is* transferring the
  bytes, and a dry run would transfer them too — same cost, almost no extra
  information. It isn't offered.
- **Batch size is 25 files, not 500 rows.** Files arrive as base64 (≈4/3 of their
  real size) inside a 15 MB request body. "Upload as many as you like" is
  honoured by the *client* splitting the selection into several bounded requests
  (`batchFilesForUpload` in `apps/fleethq/src/api/documents.ts`) and stitching
  the per-file results back together — not by one enormous request.
- **Titles are derived.** A file with no explicit title gets one from its
  filename (`Fatigue_Management_Policy_v3.pdf` → "Fatigue Management Policy v3"),
  which is what makes a 30-file import one click instead of 30 text fields.
- **`publishToKnowledgeBase`** additionally creates a **draft** Knowledge Base
  article per file, referencing the document. This needs `knowledge:create` as
  well, checked in the service because it changes what the request *does* rather
  than whether it is allowed. Drafts, not published: importing a folder is not a
  decision that every file in it is fit to publish company-wide.

### Documents are referenced, not copied

`KnowledgeArticle.sourceDocumentId` and `FormTemplate.referenceDocumentId` point
at a `Document`. A policy PDF is therefore uploaded **once** and can be a
document, the body of a knowledge article, and a form's reference material at the
same time — the zero-duplicate-data-entry rule applied to files. One upload path,
one download path, one storage switch (Postgres inline vs S3).

Each surface serves the bytes from **its own** route
(`GET /v1/knowledge-articles/:id/document`, `GET /v1/form-templates/:id/reference`)
gated on *that* surface's view permission, so publishing an SOP to drivers
actually makes it readable by them without also opening the whole document
library. An article's document follows the article's own draft/published rule.

An article is now authored markdown, an imported document, or both — `body` is
nullable, and the API refuses to create or leave an article with neither.

**Honest limitation:** a form's reference document is fetched on demand and is
*not* pre-cached for offline use. Forms still submit fine offline; the reference
PDF simply won't open in a dead spot, and DriverOS says so rather than failing
silently. Nothing required to *complete* a form should live in that document.
