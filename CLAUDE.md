# CLAUDE.md

**Read `FleetOS-Playbook/CLAUDE.md` before touching any code here.** It's the
full operating contract for FleetOS (commercial priority, terminology,
non-negotiable engineering principles, authority order). This file only adds
what's specific to this repository.

## What this repo is

`fleethq-platform` is one of three repositories that make up FleetOS:

- **This repo**: the API only (`api/`, NestJS + Prisma + PostgreSQL), the
  database schema, and the full product specification
  (`FleetOS-Playbook/`). Deploys to Railway.
- [`fleethq-frontend`](https://github.com/dylanjkf/fleethq-frontend): the
  FleetHQ office dashboard SPA, plus `admin/` — the FleetHQ staff console,
  a separate app within that repo deployed alongside it at
  `fleethq.online/admin`. Deploys to Vercel. Both talk to the API in this
  repo exclusively over HTTPS/REST — never given a local import of anything
  in `api/`, direct database access, or a shared filesystem.
- [`fleethq-driveros`](https://github.com/dylanjkf/fleethq-driveros): the
  driver/field mobile app (React/Vite + Capacitor). Its own repo so native
  app-store release tooling isn't coupled to this API's release cadence.
  Deploys: app stores (native) / installable PWA (web). Same "API only,
  never direct DB access" rule as the other two clients.

## Rules specific to this repo

- **`api/` is the only way any client reads or writes FleetOS data** — see
  `FleetOS-Playbook/12-API/API_Architecture.md`. Don't add a bypass for
  `fleethq-frontend`, `admin/`, or `fleethq-driveros` just because they're
  "trusted" — they use the same versioned REST API a third-party integration
  would.
- **Multi-tenant RLS is load-bearing, not optional.** `api/` connects as
  `fleetos_app` at request time (no `BYPASSRLS`) — see
  `FleetOS-Playbook/11-Database/Data_Model.md`. Never add a code path that
  connects as the schema-owner role to serve a request. The admin platform's
  `fleetos_admin` role is the one deliberate, documented exception (cross-
  tenant admin views are fundamentally incompatible with per-request RLS) —
  see `FleetOS-Playbook/21-Admin-Platform/Overview.md`'s isolation model.
- **`fleethq-driveros` is offline-first, always** (root non-negotiable
  principle). Its native app packaging (`ios/`, `android/` in that repo) is
  a thin Capacitor shell around the same offline-capable web app — never a
  parallel native codebase.
- **Permissions are granular, not role-based** —
  `api/src/common/permissions/permission-catalog.ts` is the source of truth
  that `fleethq-frontend`'s `src/lib/permissions.ts` deliberately mirrors.
  Change the catalog here first; that mirror is documented, expected
  duplication, not drift to "fix" by deleting one side. The admin platform
  has its own, separate catalog (`admin-permission-catalog.ts`) — the two
  are never merged, since a customer permission and a FleetHQ-staff
  permission must never be checked by the same code path.
