import { SetMetadata } from '@nestjs/common';
import { FeatureKey } from '../../billing/plans';

export const REQUIRED_FEATURE_KEY = 'requiredFeature';

/**
 * Marks a route (or a whole controller) as requiring a paid plan feature —
 * the server-side half of a paywall. Enforced by FeatureGuard on every request,
 * so a paid add-on cannot be reached by calling the API directly even if the
 * client hides the module.
 *
 * This is deliberately separate from `@RequirePermission`: permissions answer
 * "is this user allowed to do this within their company", features answer "has
 * this company paid for this capability at all". A route can need both.
 */
export const RequireFeature = (feature: FeatureKey) => SetMetadata(REQUIRED_FEATURE_KEY, feature);
