# Universal GPS Ingest

## Why

The live map originally showed positions only from a driver's phone (DriverOS
reporting while on shift). That's fragile for the office — no phone, no shift,
no dot — and it can't track an unmanned or parked asset. This adds a **universal
ingest path** so *any* GPS source (a hardware tracker, an OBD/telematics hub, a
third-party provider's webhook) can report an asset's position, independent of a
driver.

## Model

- **`GpsDevice`** — a registered tracker. Holds a secret `deviceKey` (bearer
  token), an optional `assetId` binding, a free-text `provider`/model label, and
  the denormalised latest fix (`lastLat`/`lastLng`/`lastLocationAt`).
- **`GpsPing`** — append-only breadcrumb of every reported position.

Both tables **are** RLS-protected (a FORCEd `tenant_isolation` policy, added in
the database-architecture review alongside every other tenant table). Ingest is
the one exception that cannot run under RLS: it authenticates purely by
`deviceKey` and so must resolve the tenant *from the key* before any company
context exists — a keyless lookup no per-tenant GUC can express. That single
path therefore runs through the narrow `BYPASSRLS` role (`SystemPrismaService`),
looking the device up globally and then writing only to that device's own rows.
Every user-facing method runs under the RLS-enforced tenant role via
`withTenant` **and** filters by `companyId` as defence in depth.

## Endpoints

- `POST /v1/gps/ingest` — **public** (no user login). Body:
  `{ deviceKey, lat, lng, speedKph?, headingDeg?, recordedAt? }`. Updates the
  device's latest fix and appends a ping. Unknown/disabled key → 404.
- `GET /v1/gps/devices` · `POST /v1/gps/devices` (register, returns the key
  **once**) · `PATCH /v1/gps/devices/:id` (rename / bind-unbind asset) ·
  `POST /v1/gps/devices/:id/rotate-key` (returns a fresh key once) ·
  `POST /v1/gps/devices/:id/archive` — gated by `gps_device:manage`.
- `GET /v1/gps/positions` — assets with a fix in the last 12h, for the live map;
  gated by `locations:view`.

## FleetHQ

- **Fleet → GPS trackers**: register a device, copy its key (shown once), bind
  it to an asset, rotate the key, or remove it.
- The dedicated Live Map page has been removed from FleetHQ's navigation
  (product decision, 2026-07-28). `GET /v1/gps/positions` still exists and
  still records a device's last fix (surfaced today on the GPS trackers
  settings tab), but nothing currently renders it on a map — reviving/replacing
  that consumer is out of scope for this doc.

## How to actually connect a tracker (the operator answer)

This is surfaced **in the product** — Fleet → GPS trackers → *"How to connect a
GPS tracker"* — because a bare path was not enough to configure a real device.
The panel is the source of truth for an operator; this section mirrors it.

1. **Register the tracker** in FleetHQ and copy the device key. It is shown
   **once** (only its SHA-256 hash is stored). Lost keys are replaced with
   *Rotate key*, which invalidates the old one immediately.
2. **Point the device at the absolute URL** — `https://<your-host>/v1/gps/ingest`.
   The in-app panel prints the correct host automatically (derived from the
   origin the operator is browsing). A bare `/v1/gps/ingest` is not actionable
   for a device, which was the single biggest source of confusion.
3. **Send the JSON body.** `deviceKey`, `lat`, `lng` are required; `speedKph`,
   `headingDeg`, `recordedAt` are optional. Field names are exact — `lat`/`lng`,
   **not** `latitude`/`longitude`, and coordinates must be JSON numbers, not
   quoted strings. No user token is needed; the device key *is* the credential,
   so treat it as a password.
4. **Prove the pipeline before blaming the hardware:**
   ```
   curl -X POST https://<your-host>/v1/gps/ingest \
     -H 'Content-Type: application/json' \
     -d '{"deviceKey":"<key>","lat":-33.8688,"lng":151.2093}'
   ```
   `{"accepted":true}` means it works, and the tracker's *Last fix* turns green
   (the devices table polls, so no manual reload).

### Will a given tracker work? (the honest answer)

FleetOS accepts an open HTTP JSON POST. Three things can produce one:

- a tracker with configurable **HTTP/HTTPS reporting** (common on modern 4G units);
- your telematics platform's **webhook / data forwarding** (Teltonika, Queclink,
  Samsara, Geotab and similar can all forward fixes);
- a **small adapter** you run that translates the device's protocol to the payload.

Many inexpensive trackers only speak a proprietary binary protocol over raw
TCP/UDP and **cannot** POST JSON at all — no amount of configuration will make
them work directly, and saying so up front saves hours. If the device manual has
no "server URL / HTTP" setting, options two or three are the path. Alternatively
skip hardware: DriverOS already reports the driver's phone position on shift,
which is sufficient unless ignition-off tracking is needed.

### Ingest failures and what they mean

| Response | Cause | Fix |
|---|---|---|
| 404 `GPS_DEVICE_UNKNOWN` | Key matches no active tracker | Check for typos/whitespace; rotate if lost |
| 400 `BAD_TIMESTAMP` | `recordedAt` unparseable | Send ISO 8601, or omit to default to now |
| 400 validation | Wrong field name/type (usually `latitude`/`longitude`, or string coords) | Match the payload table exactly |
| 429 | Faster than the per-device ingest limit | Report every 30–60s; that's ample for a live map |
| 200 but *Last fix: never* | Different key/device, or a different environment | Confirm the host and that it's the same tracker row |

## Deliberately out of scope (for now)

Per-provider adapters/normalisation (each vendor's payload shape), geofencing,
trip segmentation, and reading the breadcrumb trail back in the UI. The ingest
contract is intentionally generic so a thin adapter can map any provider onto it.
