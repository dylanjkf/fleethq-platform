# API Versioning & Deprecation Policy

FleetOS is **API-first**: FleetHQ, DriverOS, and any third-party integration all
use the same public HTTP API (`12-API/API_Architecture.md`). That makes the API
a contract, and contracts need a stated policy for how they change. This is it.

## Versioning

- **URI versioning.** Every route lives under a major version prefix — `/v1/...`
  today (NestJS URI versioning; see `main.ts`). The version is the *major*
  version of the contract, not the product.
- **One active major at a time, for now.** There is exactly one supported major
  (`v1`). A `v2` is introduced only for a **breaking** change that cannot be made
  additively.
- **Additive changes stay in the current major.** New endpoints, new optional
  request fields, and new response fields are backward-compatible and ship in
  `v1` without a version bump. Clients must ignore unknown response fields.

### What counts as breaking (requires a new major)

- Removing or renaming an endpoint, field, or enum value.
- Changing a field's type, or making a previously-optional request field required.
- Changing the meaning of an existing field or the semantics of an endpoint.
- Changing the error envelope shape (`{ error: { code, message, ... } }`).
- Tightening validation such that previously-valid requests now fail.

### What is NOT breaking (stays in-version)

- Adding an endpoint, an optional request field, or a response field.
- Adding a new enum value **to a response** (clients must tolerate unknowns).
- Relaxing validation; adding a new optional query parameter.
- Performance, logging, or internal refactors with no contract change.

## Deprecation

When something must be removed or changed incompatibly:

1. **Announce.** Mark it deprecated in this Playbook (and the generated
   `API_Reference.md`), and add it to the `CHANGELOG.md`.
2. **Signal at runtime.** Deprecated routes return a `Deprecation: true` header
   and a `Sunset: <date>` header (RFC 8594) indicating the earliest removal date.
   Implemented by the `@Deprecated({ sunset, link? })` decorator
   (`api/src/common/deprecation/deprecated.decorator.ts`) and a globally
   registered `DeprecationInterceptor` — annotate the handler (or controller)
   and the headers (plus an optional `Link: …; rel="deprecation"`) are emitted
   automatically; undecorated routes are unaffected.
3. **Overlap.** Keep the deprecated behaviour working for a **minimum 90-day**
   window (longer for anything third parties depend on) alongside its
   replacement, so integrators can migrate without downtime.
4. **Remove** only after the sunset date, and only in a new major version — never
   silently within `v1`.

## Stability tiers

- **Stable** (default): everything under `/v1` documented in `API_Reference.md`.
  Governed by this policy.
- **Internal/unstable**: none. Per the API-first principle there is no
  internal-only shortcut API — if FleetHQ/DriverOS can call it, so can a third
  party, and it's covered here.

## Correlation & support

Every response carries an `x-request-id` (honoured from upstream or generated;
see `app.module.ts`). Error envelopes also include `requestId`. Integrators
should log it and quote it in support requests — it ties their call to our logs
and error tracking.

## The reference

`12-API/API_Reference.md` is generated from the controllers
(`scripts/generate-api-reference.mjs`) and lists every route with its required
permission. Regenerate it whenever routes change; treat it as the source of
truth for the current surface.

## Deliberately not yet built

- A machine-readable OpenAPI/Swagger document. `@nestjs/swagger` conflicts with
  this app's pinned NestJS versions, so the surface is published as the generated
  Markdown reference for now. Emitting OpenAPI (via a compatible tool or a
  version bump) is a tracked follow-up — this policy already defines the contract
  it would formalise.
- API keys / OAuth for third parties (today's clients use user JWTs). A
  first-class integration-credential story is future roadmap.
