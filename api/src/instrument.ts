/**
 * Error tracking (the commercial-readiness review's "no monitoring exists"
 * finding, application-level half; an infra-level half — CloudWatch/alarms via
 * `infra/terraform/modules/monitoring` — is planned/target architecture, not yet
 * built). Must be imported and run before anything else,
 * including before @nestjs/core, so Sentry's auto-instrumentation can hook
 * into modules as they're first required — hence this is its own file,
 * imported as the very first line of main.ts rather than initialized inside
 * bootstrap().
 *
 * SENTRY_DSN empty/unset (the default in every environment until a real
 * Sentry project exists and its DSN is wired into the deploy config) means
 * Sentry.init() runs with no DSN, which is a documented no-op: every
 * Sentry.* call becomes a safe no-op rather than an error. Error tracking
 * being unconfigured must never be a reason the app fails to start or a
 * request fails to complete — same "AI enhances, never blocks" shape
 * (00-Company/Core_Principles.md) applied to observability instead of AI.
 */
import * as Sentry from '@sentry/node';

/** Header names that must never reach Sentry (auth material / cookies). */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'stripe-signature', 'x-api-key', 'x-device-key'];

Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1, // 10% of requests get full performance tracing — enough to spot trends without the cost/volume of tracing every request
  // Never send request bodies — they can contain operator personal data
  // (14-Security/Privacy_Data_Protection.md) and this codebase doesn't need
  // Sentry to hold a second copy of anything the app itself already logs
  // responsibly via nestjs-pino's own redaction.
  sendDefaultPii: false,
  /**
   * Explicit scrub as a visible, belt-and-braces layer over `sendDefaultPii:
   * false` (security audit, Low): strip request bodies and sensitive headers,
   * and drop cookies, from every event before it leaves the process — so a
   * future change that turns on PII, or an SDK integration that attaches a
   * request, can't silently start exfiltrating credentials/PII.
   */
  beforeSend(event) {
    if (event.request) {
      delete event.request.data; // request body
      delete event.request.cookies;
      if (event.request.headers) {
        for (const key of Object.keys(event.request.headers)) {
          if (SENSITIVE_HEADERS.includes(key.toLowerCase())) delete event.request.headers[key];
        }
      }
    }
    return event;
  },
});
