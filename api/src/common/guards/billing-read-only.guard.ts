import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { ALLOW_WHEN_READ_ONLY_KEY } from '../decorators/allow-when-read-only.decorator';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Enforces the payment-failure read-only state at the write layer (the
 * server-side half of `Entitlements.billingReadOnly`). When enforcement is on
 * and a company's paid subscription has exhausted its dunning retries, every
 * request that would MUTATE tenant data is rejected with 402 — the fleet becomes
 * look-but-don't-touch until billing is fixed. Reads are always allowed (data is
 * preserved, never deleted), and routes a past-due customer needs to *pay*
 * (Checkout, portal, quantity change, cancel) opt out via `@AllowWhenReadOnly`.
 *
 * A no-op when `BILLING_ENFORCED` isn't `true` — `isBillingReadOnly` early-returns
 * without touching the database, so dev/CI/pilot carry zero per-request cost.
 */
@Injectable()
export class BillingReadOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // Reads never blocked — read-only preserves visibility of all data.
    if (!MUTATING_METHODS.has(request.method)) return true;

    const user = request.user as AuthenticatedRequestUser | undefined;
    // Public/unauthenticated routes (login, signup, webhooks) have no company
    // to be read-only — nothing to enforce here.
    if (!user?.companyId) return true;

    // Routes the customer must reach to resolve the failure are exempt.
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WHEN_READ_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    if (await this.entitlements.isBillingReadOnly(user.companyId)) {
      throw new HttpException(
        {
          code: 'BILLING_READ_ONLY',
          message: 'Your account is read-only because a payment failed. Update your billing to make changes again.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
