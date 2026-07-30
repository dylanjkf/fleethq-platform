# Configurable Barcode Scanning

## Purpose
Office staff assembling a run in Dispatch → Create Run currently type every consignment's details by hand. Every FleetHQ customer's barcodes, warehouse software, and required fields differ, so a single hardcoded "scan a reference number" field can't serve all of them — this feature lets an administrator configure what a scan searches, what it looks up, and what it populates, without engineering involvement per customer.

## Requirements
- Barcode input via USB keyboard-wedge scanners, Bluetooth scanners, tablet/mobile camera scanning, and manual entry as a fallback — the scan field regains focus automatically after every successful scan so continuous scanning is possible.
- Admin-configurable searchable fields: which database field(s) a scan searches (Barcode, Tracking Number, Consignment Number, Manifest Number, Internal ID, Customer Reference, or a custom field) — administrators can add more without a code change.
- Admin-configurable field population: what happens once a scan resolves — direct copy (barcode → tracking number) or a database lookup (tracking number → customer / delivery address / contact / notes / service type / parcel count / weight / cubic / dangerous goods / custom fields).
- Three scan modes: Database Lookup (barcode is only an identifier), Encoded Barcode (decode fields directly from the payload), Hybrid (decode what's present, database-lookup the rest).
- Missing-information failsafe: never fail silently — show exactly which required fields are missing and let the operator create a new consignment, search manually, or keep entering fields, per a configurable required-fields policy.
- Duplicate protection: block re-adding a consignment already on the same run, already cancelled, or already dispatched — highlight the existing record instead of creating a duplicate.
- Unknown-barcode handling: "Barcode not recognised" with Search manually / Create new / Ignore options.
- Bulk-scanning UX: instant processing, automatic refocus, no page refreshes, optimistic UI, keyboard-free workflow, and a scan history for the current session.
- Modular and reusable: not tightly coupled to Create Run — the same scan input, config, and matching logic should be usable anywhere else FleetHQ later needs barcode input (receiving, sorting, cage/bin allocation, loading, dispatch confirmation, returns, inventory).

## Workflows
- Warehouse staff scan consignment after consignment into a run with a USB wedge scanner; each scan matches an existing StopParcel by whichever fields are configured searchable, auto-populates the mapped fields, and the input refocuses for the next scan with zero clicks.
- A barcode the system has never seen scans as "not recognised" — the operator taps "Create new," fills in the handful of fields the barcode itself didn't carry, and the consignment is added to the run.
- Re-scanning a consignment that's already on this run, or one that belongs to a cancelled/already-dispatched job, is blocked and the existing record is highlighted instead of a duplicate being created.

## Edge cases
- A barcode that decodes some fields (Hybrid/Encoded mode) but is missing a field the admin marked required: the scan surfaces exactly which fields are missing rather than blocking or guessing.
- A custom searchable field an admin adds after go-live must work identically to a built-in one — no special-casing in code between built-in and custom fields.

## Technical considerations
- `StopParcel` (the existing per-stop consignment/parcel record from the original barcode-scan-and-multi-parcel feature) is extended with the richer, all-nullable field set a scan can populate, rather than introducing a parallel "Consignment" entity — a bare `reference`-only parcel (the pre-existing behaviour) is unaffected.
- Admin configuration lives in three tables: `BarcodeSearchableField` (which fields are scannable, extensible without code changes), `BarcodeFieldMapping` (source → target population rules), and a per-company `BarcodeScanConfig` singleton (mode, manual-entry fallback, missing-field policy).
- `BarcodeScanEvent` records every scan (matched, duplicate-blocked, unknown, or missing-fields) for the session scan-history UI and as an audit trail.
- Encoded-barcode decoding in this v1 supports a barcode payload that's JSON or simple `key:value;key2:value2` pairs — full GS1 Application-Identifier parsing (the industry standard for logistics barcodes with embedded batch/serial/weight data) is a real, separate follow-up, not attempted here.
- Camera scanning uses the browser's native `BarcodeDetector` API where available, with graceful feature-detection (no bundled scanning library) — Safari/older browsers simply don't show the camera-scan option and fall back to USB/BT/manual.

## Acceptance criteria
- An administrator can add a new searchable field and a new field-mapping rule from Admin Settings and have it take effect on the next scan with no deployment.
- Scanning the same consignment twice onto the same run, or scanning one belonging to a cancelled job, is blocked with the existing record highlighted, not silently duplicated.
- A completely unrecognised barcode never throws an error to the operator — it always offers a next step.

## Future expansion notes
- Full GS1 barcode parsing (weight, batch, expiry, serial embedded in the barcode itself) is the natural next increment once a customer's actual barcode format is in hand to build and test against.
- The same scan input/config/matching engine is designed to extend into warehouse workflows (receiving, sorting, depot transfers, cage/bin allocation, loading, dispatch confirmation, returns, inventory) without rework — see `10-Integrations/Integration_Hub.md` for the adjacent Integration Hub work this shares a "customer-configurable, no-code-change" philosophy with.

## Implementation notes (v1, `apps/api` + `apps/fleethq`)
**Built**: `StopParcel` (the existing multi-parcel model) extended with the full nullable field set (`trackingNumber`, `consignmentNumber`, `manifestNumber`, `internalId`, `customerReference`, `deliveryAddress`, `contactName`, `deliveryNotes`, `serviceType`, `parcelCount`, `weightKg`, `cubicM3`, `dangerousGoods`, `customFields`) — a bare `reference`-only parcel is unaffected. `BarcodeSearchableField`/`BarcodeFieldMapping`/`BarcodeScanConfig` (one auto-created default per company on first read) are fully admin-editable from a new **Barcode Scanning** tab in Admin Settings (`barcode_config:manage`), and `BarcodeScanEvent` logs every scan. New module `apps/api/src/barcode/` exposes `GET/PATCH /v1/barcode/config`, CRUD for searchable fields and field mappings, `POST /v1/barcode/scan` (the core matching/mapping endpoint), `POST /v1/barcode/scan/:id/create` (create a new consignment from an unmatched or edited scan), and `GET /v1/barcode/scan-history`.

**Scan matching**: `DATABASE_LOOKUP` searches the raw scanned text across every active searchable column; `ENCODED_BARCODE` searches only using values the decode step produced, matched to their own column; `HYBRID` tries the decode-targeted search first and falls back to the raw-value search. `isDatabaseLookup` field mappings resolve off the one matched parcel already found (including its stop/customer), rather than a second per-mapping query.

**Encoded-barcode decoding (v1 scope)**: JSON payloads, or `key:value;key2:value2` pairs, with the raw string always also available under the `'scan'` source key — full GS1 Application-Identifier parsing is a real, separate follow-up (see Future expansion notes), not attempted here.

**Frontend**: `BarcodeScanInput` (Enter-to-submit for USB/BT wedge scanners, a feature-detected camera button using the native `BarcodeDetector` API where the browser supports it, manual entry always available, auto-refocus after every scan, capped 100-entry session history) is wired into Dispatch's Create Run stop editor (`JobStopsDialog`) **alongside**, not replacing, the pre-existing bare-reference quick-add — manual entry keeps working exactly as before. Outcome states (matched/duplicate-blocked/unknown/missing-fields) each render their own card with the spec's required next actions.

**Duplicate protection**: blocks re-scanning a consignment already on the run being built, or one belonging to a `CANCELLED`/`COMPLETED` (dispatched) job — the existing record is returned so the frontend can highlight it, never silently duplicated.

**No new npm dependencies** — camera scanning uses the browser-native `BarcodeDetector` API with graceful feature-detection (hidden entirely on browsers without it, e.g. Safari today).
