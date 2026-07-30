# CLAUDE.md

**Read `FleetOS-Playbook/CLAUDE.md` before touching any code here.** It's the
full operating contract for FleetOS (commercial priority, terminology,
non-negotiable engineering principles, authority order). This file only adds
what's specific to this repository.

## What this repo is

`fleethq-platform` is one of two repositories that make up FleetOS:

- **This repo**: the API (`api/`, NestJS + Prisma + PostgreSQL), the
  DriverOS mobile app (`driveros/`, React/Vite + Capacitor), the database
  schema, and the full product specification (`FleetOS-Playbook/`). Deploys:
  API → Railway, DriverOS → app stores (native) / installable PWA (web).
- [`fleethq-frontend`](https://github.com/dylanjkf/fleethq-frontend): the
  FleetHQ office dashboard SPA only. Deploys to Vercel. Talks to the API in
  this repo exclusively over HTTPS/REST — never given a local import of
  anything in `api/`, direct database access, or a shared filesystem.

## Rules specific to this repo

- **`api/` is the only way any client reads or writes FleetOS data** — see
  `FleetOS-Playbook/12-API/API_Architecture.md`. Don't add a bypass for
  `fleethq-frontend` or `driveros` just because they're "trusted" — they use
  the same versioned REST API a third-party integration would.
- **Multi-tenant RLS is load-bearing, not optional.** `api/` connects as
  `fleetos_app` at request time (no `BYPASSRLS`) — see
  `FleetOS-Playbook/11-Database/Data_Model.md`. Never add a code path that
  connects as the schema-owner role to serve a request.
- **`driveros` is offline-first, always** (root non-negotiable principle).
  Its native app packaging (`driveros/ios/`, `driveros/android/`) is a thin
  Capacitor shell around the same offline-capable web app — never a
  parallel native codebase.
- **Permissions are granular, not role-based** —
  `api/src/common/permissions/permission-catalog.ts` is the source of truth
  that `fleethq-frontend`'s `src/lib/permissions.ts` deliberately mirrors.
  Change the catalog here first; that mirror is documented, expected
  duplication, not drift to "fix" by deleting one side.
