import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-feature-flag.decorator';

/**
 * Server-side enforcement of `@RequireFeatureFlag` — see FeatureGuard's own
 * docstring for the sibling "billing entitlement" guard this is modelled on.
 * A no-op (returns true) for any route that doesn't declare a required flag.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_FEATURE_FLAG_KEY, [
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

    const enabled = await this.featureFlags.isEnabled(required, user.companyId);
    if (!enabled) {
      throw new ForbiddenException({
        code: 'FEATURE_DISABLED',
        message: 'This feature is not currently enabled for your organisation.',
        feature: required,
      });
    }

    return true;
  }
}
