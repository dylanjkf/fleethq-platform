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
