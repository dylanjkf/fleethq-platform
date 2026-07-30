# Future Direction: Open Platform / Plugin Marketplace

## Status
Foundational discipline (API-first architecture, granular permissions) is being built now, in v1. The marketplace itself — discovery, third-party developer onboarding, revenue sharing, plugin review/security process — is future scope.

## What it could eventually include
Third-party plugins for payroll integration, accounting (Xero/MYOB-style), fuel card reconciliation, insurance, custom reporting, warehouse management integration — each built by external developers against the public FleetOS API, discoverable and installable by a company admin the same way they'd install a role template today.

## Preconditions before this should be built
- API stability and versioning discipline (`12-API/API_Architecture.md`) proven in production for a meaningful period.
- Permission model (`14-Security/Permissions_Model.md`) extended to support plugin-scoped permission grants (a plugin should request exactly the permissions it needs, visible to the installing admin, never broad access by default).
- A defined security review process for third-party code/access before any plugin can reach production customer data.
