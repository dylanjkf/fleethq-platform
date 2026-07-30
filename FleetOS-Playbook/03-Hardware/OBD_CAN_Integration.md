# OBD/CAN Integration

## Purpose
Turn raw asset diagnostic data into information the platform can act on — fault detection, predictive maintenance signals, and Fleet Health Score inputs — logged automatically instead of relying on an operator to notice and report it.

## Requirements
- Read standard OBD-II PIDs (engine RPM, coolant temp, fuel level/consumption, speed, fault/DTC codes) plus manufacturer-specific CAN data where the Asset Hub supports it.
- Every OBD/CAN-sourced data point is logged with a timestamp and becomes part of the asset's Timeline and feeds the Fleet Graph and Fleet Health Score.
- Data points that are not obtainable for a given asset (no hub installed, unsupported protocol, asset too old) must be explicitly flagged as "not available" in the UI — never silently omitted or shown as a false zero/normal reading.
- Fault codes (DTCs) are decoded to human-readable descriptions, not shown as raw codes to non-technical users (raw code still available for workshop staff).

## Workflows
- Asset Hub detects a new DTC → event is logged to the asset Timeline → Fleet Health Score updates → if severity warrants it, workshop and/or dispatch are notified automatically, following the same notification pattern as Smart Checklists.
- Fleet Intelligence looks for patterns across DTCs, asset age, and Fleet Graph relationships (e.g. shared attached unit) to surface predictive maintenance recommendations.

## Edge cases
- Intermittent hub connectivity producing flapping fault states (code appears/clears repeatedly): must be debounced so it doesn't spam notifications, while still preserving the raw event history in the Timeline.
- Asset without hardware: all OBD-dependent features degrade to manual entry, clearly labeled as manual rather than sensor-sourced.

## Technical considerations
- Requires a normalization layer since different asset makes/models expose different CAN data — the goal is a consistent internal data model regardless of source hardware/asset, so the rest of the platform never has to special-case a manufacturer.

## Acceptance criteria
- Every logged fault code is human-readable, timestamped, and produces a correct Timeline entry.
- Assets without OBD/CAN hardware are clearly and correctly represented as such everywhere data would otherwise appear.

## Future expansion notes
- EV-specific data (battery health, charge state) and hydrogen/alternative-fuel telemetry are anticipated future protocol additions to this same normalization layer, not a separate system.
