# FleetHQ Admin

The internal FleetHQ staff console — a completely separate SPA from the
customer-facing `fleethq-frontend`, talking to `/v1/admin/*` on the same API
via its own authentication (see `FleetOS-Playbook/21-Admin-Platform/Overview.md`).
Desktop-only internal tool: single dark theme, no offline support, no PWA.

## Local development

```bash
npm install
npm run dev     # http://localhost:5175, proxies /v1 and /health to
                 # http://localhost:3000 (see vite.config.ts) — run the api
                 # locally alongside this, with an AdminUser already
                 # bootstrapped (see api/scripts/bootstrap-admin.ts)
npm run build
npm run lint     # oxlint
npm test         # vitest
```

## Environment variables

See `.env.example`. `VITE_API_BASE` must be set to the deployed API's
absolute URL for any build that isn't local dev — there is no same-origin
fallback once this is deployed separately from the API.

## Structure

```
src/api/          typed HTTP client — one file per admin backend module
src/app/          providers (auth), routing, shell/nav
src/components/ui/ shared UI kit (Button, Card, Table bits, dialogs...)
src/features/      one directory per admin section (dashboard, organisations,
                   customer-users, support, feature-flags, system, fleet,
                   audit-log, settings)
```

Every page is gated on the granted admin permission it needs
(`useAuth().hasPermission(key)`) — the same permission keys the backend's
`AdminPermissionGuard` enforces, so a hidden nav item / tab always matches a
route that would 403 anyway rather than the two silently drifting apart.

## Known scope decisions (not gaps)

- **Impersonation** shows the minted customer access token in a dialog for
  the admin to copy manually, rather than redirecting into
  `fleethq-frontend` — that's a separate, unattached repo/origin from this
  session's perspective, so a same-tab handoff isn't wired up yet.
- **No light theme.** Single dark console theme, v1 decision (see
  `src/index.css`).
