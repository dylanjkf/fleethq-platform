# Configurable, multi-drop-aware Proof of Delivery

Status: implemented (backend). Branch `claude/auth-billing-delivery-features`.

## Problem

Today `POST /v1/jobs/:id/stops/:stopId/complete` (`JobStopsService.completeStop`)
captures a **fixed** proof-of-delivery set: an optional POD photo, an optional
signature, a recipient name and a free-text note, all hard-coded on
`CompleteStopDto`. Two things are missing:

1. **Configurability.** Different couriers need different evidence — one wants a
   signature, one a photo, one a photo *and* a printed recipient name, one
   nothing. That set should be admin-configurable per tenant and **enforced
   server-side** (a client that omits a required photo must be rejected by the
   API, not merely nudged by the UI).
2. **Multi-drop.** A single stop can hold several parcels dropped at the same
   address. The driver should capture the evidence **once** (one signature for
   the 1–3 parcels handed over together), while each parcel's drop completion is
   still individually recorded and reportable.

The constraint is *reuse, don't fork*: the codebase already has a versioned,
snapshotting JSON-schema form engine (`FormTemplate`/`FormSubmission`,
`FormsService`) and an attachment-capture path (`AttachmentsService.createInTx`,
the base64 → `Attachment` FK pattern `completeStop` already uses for POD). This
feature is a composition of those two, not a new config system.

---

## Decision 1 — `photo` / `signature` as first-class form field types

`FORM_FIELD_TYPES` gains `photo` and `signature`. The evidence set is therefore
*just a form*: an admin builds it in the existing FormBuilder, and the existing
required/optional/conditional machinery already means "photo required, signature
optional" for free.

**How the answer is stored.** These fields never put raw base64 into the
submission JSON. Their request-side answer value is an object payload
`{ contentType, filename?, base64 }`; `FormsService.validateFieldValue` runs it
through the *existing* `AttachmentsService.createInTx` (same size cap, same
MIME-magic sniffing, same S3/inline storage swap `completeStop` relies on) and
the **persisted answer value becomes the `Attachment` id string** — identical in
spirit to how `asset_ref`/`operator_ref` persist an id, not the entity. A reader
of the submission gets an attachment id and downloads the bytes through the
normal attachment route.

**Required enforcement.** No new code path: a `photo`/`signature` field with
`required: true` and no payload is `isEmpty` in `validateAnswers` exactly like
any other missing required field, and raises the same `FORM_FIELD_REQUIRED`
rejection. `signature` accepts `image/png|jpeg|webp`; `photo` the same. Both
reuse `ALLOWED_CONTENT_TYPES`.

**Considered and rejected:**
- *A parallel "attachment answer" side-table keyed by submission+field.* Rejected:
  `Attachment` is already the file abstraction and an id-as-value matches the
  `_ref` precedent; a side-table would fork storage for no gain.
- *Keeping base64 inline in `answers` JSON.* Rejected: bloats the immutable
  submission row, duplicates bytes, and bypasses the attachment size/mime
  safeguards the constraint says to reuse.

## Decision 2 — POD template designation + the multi-drop model

### Designating the tenant's delivery-confirmation template

`FormTargetContext` gains a `DELIVERY` value. A tenant designates its evidence
set by giving a form template `targetContext: DELIVERY`, edited through the
**existing** form-template CRUD — no new config surface, the FormBuilder drives
it as-is, and versioning/snapshot discipline comes along automatically because it
is an ordinary template.

Exactly **one active (non-archived) `DELIVERY` template per company** is allowed,
enforced by a partial unique index (`form_templates_one_active_delivery_idx`).
That gives `completeStop` a single unambiguous "what does a confirmed drop
require here" to resolve. Re-configuring = edit in place (bumps version) or
archive-and-replace.

**Considered and rejected:**
- *A `Company.deliveryConfirmationTemplateId` column pointing at a template.*
  Rejected: adds a config surface (a settings endpoint to set the pointer) the
  constraint explicitly says to avoid, and lets the pointer dangle at a template
  that's since been archived. The `DELIVERY` target is self-describing and needs
  no second write.
- *A brand-new `PodConfig` entity.* Rejected outright — that is the "new config
  system" the brief forbids.

### Multi-drop: shared evidence, per-parcel completion

The evidence is captured once, per stop, as one `FormSubmission`. Linkage:

- `JobStop.podSubmissionId` → the covering submission (the shared capture).
- `StopParcel.deliveredAt` + `StopParcel.podSubmissionId` → each parcel the
  capture covers is stamped delivered and points at the same submission.

So one signature covers N parcels, yet each parcel row independently records
*when* it was delivered and *under which* evidence — individually reportable
without re-deriving it from the stop.

**One completion path, extended (preferred over a new endpoint).** `completeStop`
still owns idempotency, attachment handling and the job roll-up. It now:

1. On `DELIVERED`, resolves the tenant's active `DELIVERY` template. If one
   exists, the request **must** carry `evidence` (`{ id?, answers[] }`); the
   answers are validated against the **server's authoritative template fields**
   (not a client-sent snapshot — see below), which stores photo/signature
   attachments and enforces required fields. Missing evidence or a missing
   required field → `400`. If no `DELIVERY` template exists, the legacy
   `podPhotoBase64`/`signatureBase64` fields still work unchanged (backward
   compatible).
2. Creates the `FormSubmission`, snapshotting the server's current template
   fields at `templateVersion`, and links it via `JobStop.podSubmissionId`.
3. Marks the covered parcels delivered: `parcelIds` if supplied (validated to
   belong to the stop), otherwise **all** of the stop's parcels. Each gets
   `deliveredAt = completedAt` and `podSubmissionId`.

**Why server-authoritative fields, not the client snapshot, for the gated
evidence.** The generic `/form-submissions` path trusts the client's
`templateSnapshot` (faithful "what the user saw" record). For the *enforced* POD
gate that would be a hole: a client could submit a snapshot with `required:false`
on the photo and dodge the rule. So the POD path ignores any client snapshot and
validates + snapshots against `FormTemplate.fields` as they stand on the server
at completion time. The submission is still a real snapshot (of the server
version), so audit/versioning discipline holds; enforcement is simply not
delegated to the client. This is the deliberate difference from the generic
submit path and the reason the required-photo e2e cannot be satisfied by a
lying client.

**Common-case scope.** Built for the ordinary courier shape: 1–3 parcels at one
stop, one capture, all covered. Not modelled: splitting one stop's parcels across
several partial captures, or evidence shared across *different* stops — a stop is
the unit of shared evidence, matching how a driver actually hands parcels over at
one door. A stop with no parcels behaves exactly as before (just the stop is
marked delivered).

---

## API contract (for the client pass)

### New form field types
Template `fields[]` may include `{ type: "photo" | "signature", required?, ... }`.
In a submission's `answers[]`, a photo/signature answer is sent as:
```
{ "fieldId": "sig", "value": { "contentType": "image/png", "filename": "sig.png", "base64": "<...>" } }
```
and is **stored** as `{ "fieldId": "sig", "value": "<attachmentId>" }`. Download
the bytes via the existing attachment download route.

### Designating the POD template
`POST/PATCH /v1/form-templates` with `targetContext: "DELIVERY"`. At most one
active DELIVERY template per company (a second create/unarchive → `409
DELIVERY_TEMPLATE_EXISTS`). List/filter via `?targetContext=DELIVERY`.

### Multi-drop confirmation
`POST /v1/jobs/:jobId/stops/:stopId/complete`
```
{
  "outcome": "DELIVERED",
  "occurredAt": "2026-08-12T04:00:00Z",   // optional, clamped as before
  "recipientName": "…",                    // optional (also capturable as a text field)
  "note": "…",                             // optional
  "parcelIds": ["<uuid>", "<uuid>"],       // optional; default = all parcels at the stop
  "evidence": {                             // required iff an active DELIVERY template exists
    "id": "<uuid>",                         // optional client id for idempotent replay
    "answers": [
      { "fieldId": "photo", "value": { "contentType": "image/jpeg", "filename": "pod.jpg", "base64": "…" } },
      { "fieldId": "recipient", "value": "J. Smith" }
    ]
  }
}
```
Response (unchanged shape, enriched): `{ stop, job, replayed, jobCompleted }`
where `stop.podSubmissionId` is set and every covered `job.stops[].parcels[]` has
`deliveredAt` and `podSubmissionId` populated.

Rejections: missing evidence when required → `400 POD_EVIDENCE_REQUIRED`; a
required photo/signature/field omitted → `400 FORM_FIELD_REQUIRED`; a `parcelIds`
entry not on the stop → `400 POD_PARCEL_NOT_ON_STOP`.
