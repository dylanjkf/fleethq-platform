import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { provisionCompany } from '../companies/provision-company';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { BillingService, mapStripeStatus } from '../billing/billing.service';
import { TRIAL_PERIOD_DAYS } from '../billing/plans';
import { SignupDto } from './dto/signup.dto';

const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

export type SignupStatusResult =
  | { status: 'not_found' }
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'completed'; alreadyClaimed: true }
  | { status: 'completed'; accessToken: string; company: { id: string; name: string } };

/**
 * Public self-serve signup (19-Billing/Self_Serve_Signup.md). Payment-first: a
 * POST /v1/signup only opens a Stripe Checkout Session and stashes the intended
 * company/admin in `pending_signups`; the account is provisioned ONLY when the
 * `checkout.session.completed` webhook fires (BillingService calls
 * `provisionFromCompletedCheckout`). The success page then polls
 * `getSignupStatus`, which mints a real login session once (single-use) so the
 * new admin lands straight in the app.
 *
 * All staging reads/writes go through SystemPrismaService (fleetos_auth) — the
 * bcrypt-hashed password in `pending_signups` is never reachable from the tenant
 * runtime role. The actual company creation reuses `provisionCompany` under
 * `PrismaService.withTenant` (fleetos_app, RLS GUC pre-set to the new company
 * id) — the exact same proven path CompaniesService.signup and the seed use, so
 * grants/RLS behave identically.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly config: ConfigService,
    private readonly sessions: AuthSessionsService,
    private readonly authTokens: AuthTokensService,
    private readonly authMail: AuthMailService,
    @Inject(forwardRef(() => BillingService))
    private readonly billing: BillingService,
  ) {}

  private perAssetPriceId(): string | undefined {
    return this.config.get<string>('STRIPE_PRICE_PER_ASSET');
  }

  /**
   * Which prerequisite (if any) is preventing self-serve signup. Null = enabled.
   * Non-sensitive (config presence, not values), so it's safe to log and to hand
   * the signup page a specific reason instead of a dead "unavailable" state — the
   * exact silent-failure the broken-signup-link report was about. In production
   * `no_app_base_url` can't happen (env.validation fails the boot), so a live
   * disabled signup is almost always billing/price misconfiguration.
   */
  signupDisabledReason(): 'billing_not_configured' | 'no_per_asset_price' | 'no_app_base_url' | null {
    if (!this.billing.isConfigured()) return 'billing_not_configured';
    if (!this.perAssetPriceId()) return 'no_per_asset_price';
    if (!this.config.get<string>('APP_BASE_URL')) return 'no_app_base_url';
    return null;
  }

  /** Whether self-serve signup can run on this deployment (Stripe + per-asset price + app base URL configured). */
  isEnabled(): boolean {
    return this.signupDisabledReason() === null;
  }

  /**
   * Public pricing config for the signup page's live price preview. The preview
   * is convenience only — the actual charge is always recomputed server-side
   * (price × quantity) at Checkout — but serving the authoritative per-asset
   * price from here keeps the preview honest (one source of truth: billing_settings).
   */
  async getSignupConfig(): Promise<{ enabled: boolean; disabledReason: string | null; pricePerAssetCents: number; currency: string; billingInterval: string; gstRate: number }> {
    const settings = await this.billing.getBillingSettings();
    const disabledReason = this.signupDisabledReason();
    if (disabledReason) {
      // Loud, so a disabled signup page in a live environment is diagnosable from
      // the logs rather than presenting as a silent dead link.
      this.logger.warn(`Self-serve signup is DISABLED: ${disabledReason}. The /signup page will show its unavailable state until this is configured.`);
    }
    return {
      enabled: disabledReason === null,
      disabledReason,
      pricePerAssetCents: settings.pricePerAssetCents,
      currency: settings.currency,
      billingInterval: settings.billingInterval,
      gstRate: settings.gstRate,
    };
  }

  /**
   * Creates the Stripe Checkout Session for a new signup and stages the intended
   * account. The charge is computed server-side (price from config, quantity
   * validated) — the client's displayed total is never trusted. Returns the
   * hosted Checkout URL to redirect the browser to.
   */
  async createSignupCheckout(dto: SignupDto, ctx: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ url: string }> {
    // Honeypot: a filled hidden field is a bot. Reject without detail.
    if (dto.website && dto.website.trim() !== '') {
      throw new BadRequestException({ code: 'SIGNUP_REJECTED', message: 'Signup could not be completed.' });
    }
    const priceId = this.perAssetPriceId();
    const appBase = this.config.get<string>('APP_BASE_URL')?.replace(/\/$/, '');
    const disabledReason = this.signupDisabledReason();
    if (disabledReason || !priceId || !appBase) {
      this.logger.error(`Rejected a signup attempt because self-serve signup is not configured: ${disabledReason ?? 'unknown'}.`);
      throw new BadRequestException({ code: 'SIGNUP_NOT_CONFIGURED', message: 'Signup is temporarily unavailable. Please contact us.' });
    }

    const email = dto.adminEmail.trim().toLowerCase();
    // Duplicate-email policy (confirmed default): one account per email. The
    // login identifier is the username, which we set to the email, so this also
    // guarantees provisioning can't hit a username-unique violation later.
    const existing = await this.systemPrisma.user.findUnique({ where: { username: email }, select: { id: true } });
    if (existing) {
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'An account with this email already exists. Please sign in instead.' });
    }

    const quantity = dto.quantity;
    const pendingId = randomUUID();
    const stripe = this.billing.getStripeClient();
    // Hash before any persistence so plaintext never lands in the DB.
    const hashedPassword = await bcrypt.hash(dto.adminPassword, resolveBcryptCost());

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer_email: email,
        line_items: [{ price: priceId, quantity, adjustable_quantity: { enabled: true, minimum: 1 } }],
        // Success page observes provisioning + logs the user in; cancel returns
        // to the signup form. No client-supplied URLs (avoids open-redirect).
        success_url: `${appBase}/signup/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appBase}/signup?cancelled=1`,
        // No client_reference_id (that means "existing company" to the webhook);
        // fleetosSignupId marks this as a signup. fleetosCompanyId is attached to
        // the subscription only after provisioning (no company exists yet).
        metadata: { fleetosSignupId: pendingId },
        // 7-day free trial (Part 2), driven by the SAME single-source constant
        // (TRIAL_PERIOD_DAYS) as the rest of the app rather than a separately
        // hardcoded number — so Stripe's own trial and FleetOS's tracking can
        // never drift apart. The card is collected now; billing starts after.
        subscription_data: { metadata: { fleetosSignupId: pendingId }, trial_period_days: TRIAL_PERIOD_DAYS },
        ...(this.billing.isTaxEnabled() ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
      },
      { idempotencyKey: `signup:${pendingId}` },
    );
    if (!session.url) {
      throw new BadRequestException({ code: 'CHECKOUT_SESSION_FAILED', message: 'Could not start checkout. Please try again.' });
    }

    await this.systemPrisma.pendingSignup.create({
      data: {
        id: pendingId,
        stripeCheckoutSessionId: session.id,
        companyName: dto.companyName.trim(),
        adminEmail: email,
        adminName: dto.adminName.trim(),
        requestedQuantity: quantity,
        hashedPassword,
        expiresAt: new Date(Date.now() + SIGNUP_TTL_MS),
      },
    });
    await this.systemPrisma.billingAuditLog.create({
      data: { eventType: 'SIGNUP_STARTED', detail: { pendingId, quantity, email, ip: ctx.ip ?? null } },
    });

    return { url: session.url };
  }

  /**
   * Provisions the real company + admin + subscription from a completed signup
   * checkout. Called by the billing webhook. Idempotent and race-safe via an
   * atomic PENDING→COMPLETED claim: only one delivery wins; a failure rolls the
   * claim back so Stripe's redelivery can retry. A no-op if the session isn't a
   * signup (no matching pending row) or was already provisioned.
   */
  async provisionFromCompletedCheckout(session: Stripe.Checkout.Session, subscription: Stripe.Subscription): Promise<void> {
    const pending = await this.systemPrisma.pendingSignup.findUnique({ where: { stripeCheckoutSessionId: session.id } });
    if (!pending) {
      this.logger.log(`checkout.session.completed with no pending signup (session ${session.id}) — not a signup, or already cleaned up`);
      return;
    }
    if (pending.status === 'COMPLETED') return;

    // Atomically claim provisioning. Only the delivery that flips PENDING→COMPLETED proceeds.
    const claim = await this.systemPrisma.pendingSignup.updateMany({
      where: { id: pending.id, status: 'PENDING' },
      data: { status: 'COMPLETED' },
    });
    if (claim.count === 0) return;

    const item = subscription.items.data[0];
    const quantity = item?.quantity ?? pending.requestedQuantity;
    const priceId = item?.price.id ?? null;
    const period = subscription as unknown as { current_period_start?: number; current_period_end?: number };
    const companyId = randomUUID();

    try {
      // Reuse the proven provisioning path under RLS (fleetos_app, GUC pre-set).
      const provisioned = await this.prisma.withTenant(companyId, async (tx) => {
        const result = await provisionCompany(tx, {
          companyId,
          companyName: pending.companyName,
          adminUsername: pending.adminEmail,
          adminPasswordHash: pending.hashedPassword ?? undefined,
          adminFullName: pending.adminName,
          adminEmail: pending.adminEmail,
          termsAcceptedAt: new Date(),
        });
        // Mirror the authoritative Stripe subscription state onto the new company.
        await tx.company.update({
          where: { id: companyId },
          data: {
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionItemId: item?.id ?? null,
            subscriptionStatus: mapStripeStatus(subscription.status),
            planPriceId: priceId,
            assetQuantity: quantity,
            currentPeriodStart: period.current_period_start ? new Date(period.current_period_start * 1000) : null,
            currentPeriodEnd: period.current_period_end ? new Date(period.current_period_end * 1000) : null,
            lastStripeEventAt: new Date(),
          },
        });
        return result;
      });

      await this.systemPrisma.billingAuditLog.create({
        data: {
          companyId,
          eventType: 'SIGNUP_COMPLETED',
          detail: { quantity, sessionId: session.id, subscriptionId: subscription.id },
        },
      });

      // Attach fleetosCompanyId to the subscription so future subscription/
      // invoice webhooks resolve to this company (best-effort).
      try {
        await this.billing.getStripeClient().subscriptions.update(subscription.id, {
          metadata: { fleetosCompanyId: companyId, fleetosSignupId: pending.id },
        });
      } catch (err) {
        this.logger.warn(`Provisioned company ${companyId} but could not tag its Stripe subscription: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Best-effort welcome/verify email — must never fail provisioning.
      try {
        const token = await this.authTokens.issue(provisioned.adminUserId, 'EMAIL_VERIFY');
        await this.authMail.sendVerification(pending.adminEmail, pending.adminName, token);
      } catch {
        // swallow — verification can be re-requested in-app
      }

      this.logger.log(`Provisioned self-serve signup: company ${companyId} (${quantity} assets) from session ${session.id}`);
    } catch (err) {
      // Roll the claim back so Stripe's webhook redelivery re-attempts. provisionCompany
      // is a single transaction, so nothing partial persists on failure.
      await this.systemPrisma.pendingSignup.updateMany({ where: { id: pending.id }, data: { status: 'PENDING' } });
      this.logger.error(`Failed to provision signup for session ${session.id} — rolled back for retry: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Polled by the success page. Once provisioning is COMPLETED, mints a login
   * session for the new admin — exactly once (single-use `loginClaimedAt`), so
   * the browser-visible Checkout session id can't be replayed to log in again.
   */
  async getSignupStatus(sessionId: string, ctx: { ip?: string | null; userAgent?: string | null } = {}): Promise<SignupStatusResult> {
    const pending = await this.systemPrisma.pendingSignup.findUnique({ where: { stripeCheckoutSessionId: sessionId } });
    if (!pending) return { status: 'not_found' };
    if (pending.status === 'EXPIRED') return { status: 'expired' };
    if (pending.status !== 'COMPLETED') return { status: 'pending' };

    // Single-use login: only the first poll to flip loginClaimedAt mints a token.
    const claim = await this.systemPrisma.pendingSignup.updateMany({
      where: { id: pending.id, loginClaimedAt: null },
      data: { loginClaimedAt: new Date() },
    });
    if (claim.count === 0) return { status: 'completed', alreadyClaimed: true };

    const user = await this.systemPrisma.user.findUnique({
      where: { username: pending.adminEmail },
      select: { id: true, tokenVersion: true },
    });
    // Memberships sit behind RLS; the privileged fleetos_auth role has no grant
    // on company_memberships (by design). Resolve them the same way login does —
    // the app role under a user-scoped context.
    const membership = user
      ? await this.prisma.withUser(user.id, (tx) =>
          tx.companyMembership.findFirst({
            where: { userId: user.id, archivedAt: null },
            select: { id: true, companyId: true, company: { select: { name: true } } },
          }),
        )
      : null;
    if (!user || !membership) {
      // COMPLETED but the admin isn't found — inconsistent; release the claim and report pending.
      await this.systemPrisma.pendingSignup.updateMany({ where: { id: pending.id }, data: { loginClaimedAt: null } });
      return { status: 'pending' };
    }

    const accessToken = await this.sessions.issueSessionToken(user.id, membership.companyId, membership.id, user.tokenVersion, {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { status: 'completed', accessToken, company: { id: membership.companyId, name: membership.company.name } };
  }

  /**
   * Marks PENDING signups past their TTL as EXPIRED (scheduled cleanup so
   * abandoned checkouts don't accumulate). Returns how many were expired.
   */
  async expireStalePendingSignups(now: Date = new Date()): Promise<number> {
    const result = await this.systemPrisma.pendingSignup.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) this.logger.log(`Expired ${result.count} stale pending signup(s).`);
    return result.count;
  }

  /**
   * Reconciliation safety net for the worst failure mode a payment-first signup
   * can have: the customer paid, but the `checkout.session.completed` webhook
   * never arrived (or kept failing), leaving them charged with no account. Finds
   * PENDING signups past a short grace window, consults Stripe's authoritative
   * Checkout Session state, and either:
   *  - re-drives the idempotent provisioning when the session is actually
   *    paid + complete (recovering a missed/failed webhook), or
   *  - raises a staff-actionable SIGNUP_PROVISION_FAILED audit alert (deduped
   *    per session) when provisioning still fails.
   *
   * Unpaid/expired sessions are genuine abandonment and left to the expiry
   * sweep. Cross-tenant with no company context, so it runs via the privileged
   * client. No-op when Stripe isn't configured; the batch is bounded so a
   * backlog can't stall the sweep.
   */
  async reconcileStuckSignups(now: Date = new Date()): Promise<{ checked: number; recovered: number; failed: number }> {
    if (!this.billing.isConfigured()) return { checked: 0, recovered: 0, failed: 0 };
    const graceMs = Number(this.config.get<string>('SIGNUP_RECONCILE_GRACE_MS')) || 10 * 60 * 1000;
    const cutoff = new Date(now.getTime() - graceMs);
    const candidates = await this.systemPrisma.pendingSignup.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (candidates.length === 0) return { checked: 0, recovered: 0, failed: 0 };

    const stripe = this.billing.getStripeClient();
    let recovered = 0;
    let failed = 0;
    for (const pending of candidates) {
      try {
        const session = await stripe.checkout.sessions.retrieve(pending.stripeCheckoutSessionId);
        // Only a paid + complete session represents money actually taken.
        if (session.payment_status !== 'paid' || session.status !== 'complete' || !session.subscription) continue;
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        await this.provisionFromCompletedCheckout(session, subscription);
        recovered += 1;
        this.logger.log(`Reconciliation recovered a stuck signup (session ${pending.stripeCheckoutSessionId}).`);
      } catch (err) {
        failed += 1;
        await this.raiseProvisionFailedAlert(pending, err);
      }
    }
    if (recovered > 0 || failed > 0) {
      this.logger.log(`Signup reconciliation: ${candidates.length} checked, ${recovered} recovered, ${failed} still failing.`);
    }
    return { checked: candidates.length, recovered, failed };
  }

  /**
   * Raise a staff-actionable alert that a paid signup couldn't be provisioned.
   * The channel is the billing audit log (companyId null — no company exists) —
   * the same append-only trail staff already browse — plus an error-level log
   * line (Sentry-captured where configured). Deduped per session so a persistently
   * failing signup alerts once, not once per sweep.
   */
  private async raiseProvisionFailedAlert(
    pending: { id: string; stripeCheckoutSessionId: string; adminEmail: string; companyName: string },
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `STUCK SIGNUP: paid checkout ${pending.stripeCheckoutSessionId} (${pending.adminEmail}) failed to provision — ${message}`,
    );
    const existing = await this.systemPrisma.billingAuditLog.findFirst({
      where: { eventType: 'SIGNUP_PROVISION_FAILED', detail: { path: ['sessionId'], equals: pending.stripeCheckoutSessionId } },
      select: { id: true },
    });
    if (existing) return;
    await this.systemPrisma.billingAuditLog.create({
      data: {
        companyId: null,
        eventType: 'SIGNUP_PROVISION_FAILED',
        detail: {
          sessionId: pending.stripeCheckoutSessionId,
          pendingSignupId: pending.id,
          email: pending.adminEmail,
          companyName: pending.companyName,
          error: message,
        },
      },
    });
  }
}
