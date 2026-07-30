import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from '../../billing/entitlements.service';
import { FeatureKey } from '../../billing/plans';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { REQUIRED_FEATURE_KEY } from '../decorators/require-feature.decorator';

/**
 * Server-side paywall for paid add-ons. Resolves the caller's company
 * entitlements fresh on every request (same no-caching reasoning as
 * PermissionGuard: a plan change must take effect without a re-login) and
 * rejects with **402 Payment Required** when the company's plan doesn't include
 * the feature the route declares via `@RequireFeature`.
 *
 * A 402 (not 403) is deliberate: this is "your plan doesn't cover this",
 * not "you aren't allowed" — the client shows an upgrade prompt, and it matches
 * the `PLAN_LIMIT_REACHED` shape EntitlementsService already returns for limits.
 *
 * When `BILLING_ENFORCED` is not `true` (the default for dev/CI/pilot),
 * EntitlementsService reports the unlimited tier, so this guard is a no-op —
 * the paywall only bites once billing enforcement is switched on.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRED_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedRequestUser | undefined;
    if (!user) {
      // JwtAuthGuard runs first and would already have rejected this; defensive only.
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Authentication required.' });
    }

    const entitlements = await this.entitlements.getForCompany(user.companyId);
    if (!entitlements.features.includes(required)) {
      throw new HttpException(
        {
          code: 'FEATURE_NOT_IN_PLAN',
          message: `Your ${entitlements.planName} plan doesn't include this feature. Upgrade to enable it.`,
          feature: required,
          planKey: entitlements.planKey,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
