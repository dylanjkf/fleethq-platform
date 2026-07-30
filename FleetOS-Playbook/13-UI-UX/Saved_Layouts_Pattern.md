# Saved Layouts (reusable, deployable presets)

A recurring product need across FleetOS: a customer configures something once,
saves it as a named preset, and reuses it across many entities without
re-entering it — "the same settings for different trucks." This is the **Saved
Layout** pattern. Every feature that has customer-tunable configuration which
would sensibly be shared across records should follow it, so the experience is
consistent everywhere.

## The shape

1. **A company-scoped template entity** — the saved layout. Always has:
   `companyId`, `name`, `archivedAt` (soft-delete), and the configuration
   itself (structured columns for a fixed schema, or a JSON `items`/`config`
   column when the customer defines the fields — "fully customizable"). An
   optional `isDefault` boolean marks the company-wide fallback.
2. **A deploy action** — `POST /<resource>/:id/deploy` — that applies the
   template to N targets in one call (assign a foreign key, or materialise
   per-target instance rows). Deploy is **idempotent**: re-deploying doesn't
   duplicate, and revives an archived instance rather than creating a second.
3. **Resolution order** where a target reads its effective config:
   target's explicit assignment → company default → built-in system default.
   Archiving a template never breaks targets — they fall back automatically.
4. **RLS tenant isolation** on every table, same policy as the rest of the app.

## Where it's implemented today

| Feature | Template entity | Deploys to | Instance / assignment |
| --- | --- | --- | --- |
| **Forms** | `FormTemplate` | — (filled per submission) | `FormSubmission` |
| **Checklists** | `ChecklistTemplate` | — (filled per submission) | `ChecklistSubmission` |
| **Fatigue rules** | `FatigueRuleSet` (+ `isDefault`) | operators | `Operator.fatigueRuleSetId` |
| **Maintenance schedules** | `MaintenanceScheduleTemplate` (+ `isDefault`) | assets/trucks | `AssetMaintenancePlan` (one per item per asset) |
| **Machine schedules** | `MaintenanceScheduleTemplate` / another machine's plans | warehouse machines | `WarehouseMachinePlan` (copy-to-machines) |
| **Notification presets** | `NotificationPreset` | users | `User.digestOnlyNotifications` + `mutedNotificationTypes` |
| **Dashboard layouts** | `DashboardLayoutPreset` (+ `isDefault`) | users | `CompanyMembership.dashboardLayout` |
| **Checklist bundles** | `ChecklistBundle` (`ChecklistBundleItem` members) | an asset class | member `ChecklistTemplate.appliesToAssetClassId` |
| **Address books** | `AddressBook` (`entries` JSON payload) | this or another company | `Depot` / `Customer` rows (apply, idempotent by name) |
| **Roles** | `Role` (`isSystemTemplate`) | — (cloned/assigned) | `CompanyMembership.roleId` |

The two most recent (Fatigue, Maintenance schedules) are the canonical
reference implementations of the full template-+-deploy shape — copy their
service/controller structure when adding the next one.

## Cross-company variant (Address books)

Most Saved Layouts deploy *within* one company, so the template row and its
targets share a `companyId` and RLS never has to be crossed. **Address books**
are the exception: a multi-entity operator saves one company's depots/customers
and re-uses them in a *different* company they run. Rather than let one
company's row deploy into another (which would breach tenant isolation), the
book is exported as a plain JSON **payload** that the operator carries across;
the importing company creates its *own* `AddressBook` row from that payload and
`apply`s it into its own `Depot`/`Customer` tables (idempotent by name). The
row always lives in whichever company owns it, so RLS holds — only data, never
a row, crosses the boundary. Use this payload-transfer shape whenever a Saved
Layout genuinely needs to move between tenants.

## Candidate future surfaces

Good fits, not yet built — each would follow the exact shape above.

## Rule of thumb

If a customer would ever say "I want to use the same settings on another
[truck / driver / user / machine]", build it as a Saved Layout — a template
entity plus a deploy action — not as per-record fields they re-enter. If the
configuration is genuinely one-off (a single company-wide toggle), a plain
settings row is fine; don't over-abstract.
