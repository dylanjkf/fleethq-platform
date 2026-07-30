# Hardware Strategy & Universal Asset Hub

## Purpose
Define how FleetOS connects to a physical asset without making hardware a dependency of the software business.

## Core decision
FleetOS is BYO-tablet: customers use their own Android tablets rather than being required to buy proprietary hardware. FleetOS maintains a supplier agreement with a hardware partner so customers who want a recommended tablet, mount, and asset hub have an easy, vetted option — but nothing in the software requires it. Hardware revenue, if pursued, is additive, never load-bearing for the business.

## The Asset Hub
A small connected device that bridges the asset's OBD-II/CAN port to the operator's Android tablet, normally installed once and left in the asset permanently — removed only for maintenance, replacement, or to physically move it between assets.

Baseline v1 capability:
- OBD-II / CAN Bus read access (engine data, fault codes)
- GPS
- Bluetooth/WiFi connectivity to the paired tablet
- Basic accelerometer (harsh braking/acceleration signal)

Reasonable additive capability worth planning for, even if not all built at launch:
- Cellular (4G/5G) fallback connectivity for the hub itself, independent of the tablet's own connection
- Attached unit connection port (detect hitch/unhitch events feeding Fleet Graph pairing relationships)
- Temperature probe input (for refrigerated/temperature-sensitive freight)
- Weight/load sensor input
- Dashcam and reverse camera input
- Battery backup (so a brief power interruption doesn't lose an in-progress sync)
- Digital I/O / expansion ports for future sensor types not yet defined
- SOS/emergency button

## Tablet-side requirements
- Standard consumer Android tablet, dockable in-asset.
- DriverOS must run acceptably on modest, non-flagship Android hardware — the requirement is broad compatibility, not chasing the newest device.
- Asset dock/mount is a recommended accessory via the supplier partnership, not a software requirement.

## Edge cases
- Asset without a working OBD/CAN port (older asset, non-standard equipment) — DriverOS and FleetHQ must function fully for that asset with manual data entry, explicitly flagging which data points aren't available rather than showing blank or misleading fields.
- Hub temporarily removed for asset service: system should tolerate a gap in telemetry without treating it as a fault or triggering false alerts.
- Hub swapped between assets: must correctly re-associate to the new asset, not silently attribute data to the wrong one.

## Acceptance criteria
- The platform functions correctly (with appropriate manual fallback) for an asset with zero hardware installed, an asset with tablet-only, and an asset with tablet + full hub.
- No core software workflow requires FleetOS-branded/owned hardware to function.

## Future expansion notes
- The full "Universal Asset Hub" concept — one box handling all of the additive capabilities above simultaneously — is a hardware product roadmap in its own right, pursued only if/when a distribution partnership makes it commercially sound, per `00-Company/Mission.md`'s business model constraint.
