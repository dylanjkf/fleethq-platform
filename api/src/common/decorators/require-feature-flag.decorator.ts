import { SetMetadata } from '@nestjs/common';

export const REQUIRED_FEATURE_FLAG_KEY = 'requiredFeatureFlag';

/**
 * Marks a route (or a whole controller) as gated by an admin-managed
 * rollout flag — enforced by `FeatureFlagGuard` on every request. Deliberately
 * separate from `@RequireFeature` (billing entitlements: "has this company
 * paid for this") and `@RequirePermission` (authz: "is this user allowed") —
 * this axis answers "has FleetHQ staff turned this on for this company right
 * now", independent of plan or role. A route can combine all three.
 */
export const RequireFeatureFlag = (key: string) => SetMetadata(REQUIRED_FEATURE_FLAG_KEY, key);
