import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_ONLY_KEY = 'authenticatedOnly';

/**
 * Marks a route as requiring a valid authenticated session but *no* specific
 * granted permission — e.g. "see my own identity", "manage my own MFA",
 * "read my own notification preferences". Data is still tenant-scoped by RLS.
 *
 * This is the explicit counterpart to `@RequirePermission`. `PermissionGuard`
 * is deny-by-default: a protected route must declare itself as exactly one of
 *   • `@Public()`            — unauthenticated,
 *   • `@RequirePermission()` — gated on a permission, or
 *   • `@AuthenticatedOnly()` — authenticated, deliberately permission-free.
 * A route that declares none is treated as a misconfiguration and denied, so a
 * handler that simply *forgot* its `@RequirePermission` can never silently fall
 * through to "reachable by any authenticated user". The
 * route-permission-coverage test enforces the same rule at build time.
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);
