import { SetMetadata } from '@nestjs/common';

export const DEPRECATION_METADATA_KEY = 'api:deprecation';

export interface DeprecationOptions {
  /**
   * Earliest removal date (RFC 8594 `Sunset`). Any value `new Date()` parses —
   * an ISO date is fine; it's emitted to clients as an HTTP-date.
   */
  sunset: string;
  /** Optional successor/docs URL, emitted as a `Link` header with `rel="deprecation"`. */
  link?: string;
}

/**
 * Marks a route (or whole controller) as deprecated per
 * 12-API/API_Versioning_Policy.md: the response then carries `Deprecation: true`
 * and `Sunset: <date>` (RFC 8594) via DeprecationInterceptor, so integrators get
 * a runtime signal rather than only a docs note. Actual removal still happens
 * only after the sunset date and in a new major version — this is the "signal at
 * runtime" step, not the removal itself.
 */
export const Deprecated = (options: DeprecationOptions) => SetMetadata(DEPRECATION_METADATA_KEY, options);
