/**
 * Shared per-route throttle presets for `@Throttle(...)`.
 *
 * The app-wide default (AppModule) is a generous 300/min/IP so ordinary use is
 * never limited. These presets tighten specific *authenticated* routes that are
 * expensive or abusable — bulk imports, broadcasts, uploads, device
 * registration, data exports — so a single logged-in account can't hammer them.
 *
 * As with the app-wide default and the auth throttle, limits are effectively
 * disabled under `NODE_ENV=test` (each e2e suite fires many requests at one
 * instance); the real limits apply everywhere else.
 *
 * NOTE: the throttler store is per-instance (in-memory), so under horizontal
 * scaling the effective ceiling is `limit × instance-count`. The WAF's
 * distributed per-IP rate rule (infra/terraform/.../waf.tf) is the backstop for
 * truly distributed abuse; these are the app-level guard rails.
 */
const isTest = process.env.NODE_ENV === 'test';

/** A named-`default`-bucket throttle config for `@Throttle(...)`. */
export const routeThrottle = (limit: number, ttlMs = 60_000) => ({
  default: { limit: isTest ? 100_000 : limit, ttl: ttlMs },
});

/** Bulk/import and broadcast routes: heavy fan-out, a handful per minute is plenty. */
export const BULK_THROTTLE = routeThrottle(20);

/** Fan-out-to-everyone routes (e.g. message broadcast): tighter still. */
export const BROADCAST_THROTTLE = routeThrottle(10);

/** Binary upload routes: each request can carry megabytes. */
export const UPLOAD_THROTTLE = routeThrottle(60);

/** Credential/registration-style routes that mint long-lived secrets. */
export const REGISTRATION_THROTTLE = routeThrottle(30);

/** Expensive data-export routes (full-tenant export / erasure). */
export const EXPORT_THROTTLE = routeThrottle(5);

/**
 * Public, unauthenticated GPS ingest (`POST /v1/gps/ingest`). It carries a
 * device key in the body, so an attacker guessing keys from one IP would
 * otherwise get the full 300/min generic bucket. The per-device flood guard in
 * GpsService only bounds a *resolved* device; guessed (invalid) keys resolve to
 * no device, so this IP bucket is what caps key-guessing volume. Kept generous
 * enough (120/min) not to break a legitimate handful of trackers behind one
 * shared IP — a large aggregating gateway is the rare exception the WAF's
 * distributed rule covers.
 */
export const GPS_INGEST_THROTTLE = routeThrottle(120);

/**
 * Public, unauthenticated inbound integration webhook
 * (`POST /v1/integrations/webhooks/in/:token`). Signature-verified when an HMAC
 * secret is configured, but a connection set up *without* one authenticates on
 * the path token alone — so tighten the bucket the same way the credential
 * routes are tightened. Inbound webhooks are low-frequency, so 60/min is ample.
 */
export const INBOUND_WEBHOOK_THROTTLE = routeThrottle(60);

/**
 * Cross-tenant admin search (`GET /v1/admin/search`). Each call runs
 * case-insensitive `contains` scans across several tables (orgs/users/assets),
 * so it is markedly heavier than an ordinary read — the 300/min default would
 * let a single logged-in staff account hammer it. 120/min is generous enough
 * for a debounced type-ahead a real person drives, tight enough to bound a
 * script fanning the multi-table scan.
 */
export const SEARCH_THROTTLE = routeThrottle(120);

/**
 * FleetHQ-staff admin-platform actions with real financial or account-
 * takeover blast radius (billing mutations, impersonation, resetting a
 * customer's MFA/lockout) — the app-wide 300/min default is far too loose
 * for these; a genuine support workflow never needs more than a handful per
 * minute. Deliberately separate from `admin-auth`'s own tighter
 * `ADMIN_AUTH_THROTTLE` (10/min), which guards credential/code-checking
 * routes specifically.
 */
export const ADMIN_SENSITIVE_ACTION_THROTTLE = routeThrottle(20);
