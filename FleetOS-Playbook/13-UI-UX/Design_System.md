# UI/UX Design System — Overview

## Purpose
Ensure DriverOS and FleetHQ feel like one coherent product, not two apps built by different teams, and that "simplicity first" is enforced visually and interactively, not just conceptually.

## Design principles (specific to UI, extending Core_Principles.md)
- **Default path is always the shortest path.** The most common action on any screen is the most visually prominent and reachable within one tap/click from that screen's entry point.
- **No dead ends.** Every screen offers a clear next action, including Universal Search/Command Bar access, so a user is never stuck wondering what to do.
- **Status is always visible, never buried.** Asset health, sync status (especially offline/pending-sync state), and compliance risk are shown persistently where relevant, not hidden behind a drill-down.
- **One visual language, two form factors.** Shared color system, iconography, typography, and component library across DriverOS (tablet, glanceable, large touch targets) and FleetHQ (desktop, denser information, precise pointer interaction).

## Component library (v1 scope)
Buttons, form inputs (including the field types needed for Universal Forms/Smart Checklists), data tables (FleetHQ), cards, timeline/feed components (for entity Timelines), map components (Dispatch), status badges (health score, compliance risk, sync state), modal/confirmation patterns, navigation shell for both DriverOS and FleetHQ.

## Accessibility & environment considerations
- DriverOS must remain usable in bright sunlight (in-cab glare) and with gloved hands where relevant to the operator's work environment — sufficient contrast and touch-target sizing are requirements, not polish.
- FleetHQ must meet standard web accessibility practices (keyboard navigation, screen reader support, color-contrast compliance) since office staff usage patterns vary.

## Acceptance criteria
- A shared component library is used by both DriverOS and FleetHQ rather than each maintaining separate implementations of the same visual concepts.
- Sync/offline state is visibly represented on every screen where a user might otherwise assume connectivity.

## Future expansion notes
- White-label theming (for future enterprise or reseller customers) should be considered when the component library's token system is designed, even though white-label capability itself is a later-phase business decision (`18-Future/`), so that theming doesn't require a retrofit.

## Implementation notes
- FleetHQ's v1 component library is built in `apps/fleethq/src/components/ui/` on Radix UI primitives + Tailwind v4 (CSS-first `@theme`, oklch color tokens) + class-variance-authority: Button, Card, Badge, Input, Label, Dialog, Drawer, DropdownMenu, Select, Switch, Checkbox, Tabs, Tooltip, Avatar, Table, Skeleton, EmptyState, ErrorState, StatusBadge, Breadcrumbs, Panel, Toast, Form (react-hook-form integration), ConfirmDialog — this is the actual shared library referenced above, not yet shared with DriverOS since no DriverOS client exists yet.
- Theme tokens live in `apps/fleethq/src/index.css` as CSS custom properties (`--surface-0/1/2`, `--border-subtle`, `--text-primary/secondary/tertiary`, `--color-accent-*`, `--color-success/warning/danger-500`) with light/dark variants toggled via a `.dark` class — the token layer white-label theming would extend, per the future-expansion note above.
- Command Palette (Cmd/Ctrl+K) is built as the "Universal Search" foundation: navigation-only today (jump to any page you have permission for), a real working subset rather than a mock, extensible to full entity search once a search endpoint exists.
- Accessibility: standard Radix keyboard/focus-trap behavior is inherited throughout; no dedicated screen-reader audit has been done yet against this doc's "standard web accessibility practices" acceptance bar — flagged as an open item, not yet verified.
