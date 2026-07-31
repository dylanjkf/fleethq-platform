import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { BillingMailService } from './billing-mail.service';
import { PAID_TIERS, isTrialActive } from './plans';

/**
 * FOUNDER_NOTES.md gap #4 / PRODUCT_ROADMAP.md's "Billing & subscription
 * management spec" — see 19-Billing/Billing_And_Subscriptions.md for the
 * full design. Stripe is the source of truth for plans/pricing/payment
 * methods; this service only ever stores what FleetOS itself needs to
 * answer "is this company's subscription in good standing" (subscriptionStatus)
 * and "which Stripe objects belong to them" (the two Stripe IDs on Company).
 *
 * Every Company read/write here goes through `PrismaService.withTenant` —
 * `companies` has the same row-level-security policy as every other tenant
 * table (`id = current_setting('app.current_company_id')`), so a plain
 * `this.prisma.company.findUnique(...)` with no tenant context set finds
 * nothing at all, not an "access denied": that's exactly the bug this
 * comment exists to stop from recurring (found by live-testing this
 * endpoint, not by review — see the webhook-metadata note below for how the
 * "don't yet know the companyId" case is solved without ever needing to
 * bypass RLS to look one up).
 *
 * Deliberately tolerant of Stripe not being configured at all (no
 * STRIPE_SECRET_KEY set) — local dev and this codebase's own e2e/CI runs
 * have no real Stripe account, and per this doc's own "billing informs,
 * never hard-locks out" v1 decision, a company with subscriptionStatus=NONE
 * is not blocked from using the product; only the billing endpoints that
 * need to actually talk to Stripe fail clearly if it isn't configured.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly billingMail: BillingMailService,
  ) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('STRIPE_SECRET_KEY');
  }

  private getStripe(): Stripe {
    if (!this.stripeClient) {
      const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
      if (!secretKey) {
        throw new BadRequestException({
          code: 'BILLING_NOT_CONFIGURED',
          message: 'Billing is not configured on this deployment (no Stripe secret key set).',
        });
      }
      this.stripeClient = new Stripe(secretKey);
    }
    return this.stripeClient;
  }

  /**
   * Public accessor for the same lazily-initialised Stripe client — used by
   * the FleetHQ admin platform's billing operations (21-Admin-Platform/Overview.md,
   * Phase 4: refunds, coupons, manual invoices, credit notes, payment retry,
   * cancel/reinstate), which need broader Stripe API surface than this
   * service's own customer-facing methods expose. Centralising client
   * creation/error-handling here (rather than a second Stripe SDK instance
   * in the admin module) keeps "billing not configured" behaving identically
   * everywhere it's checked.
   */
  getStripeClient(): Stripe {
    return this.getStripe();
  }

  async getStatus(companyId: string) {
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: {
          subscriptionStatus: true,
          planPriceId: true,
          stripeCustomerId: true,
          trialEndsAt: true,
          paymentFailureCount: true,
          lastPaymentFailedAt: true,
          nextPaymentAttemptAt: true,
        },
      }),
    );
    return {
      subscriptionStatus: company.subscriptionStatus,
      planPriceId: company.planPriceId,
      hasStripeCustomer: !!company.stripeCustomerId,
      billingConfigured: this.isConfigured(),
      trialEndsAt: company.trialEndsAt ? company.trialEndsAt.toISOString() : null,
      trialActive: isTrialActive(company.trialEndsAt),
      paymentFailureCount: company.paymentFailureCount,
      lastPaymentFailedAt: company.lastPaymentFailedAt ? company.lastPaymentFailedAt.toISOString() : null,
      nextPaymentAttemptAt: company.nextPaymentAttemptAt ? company.nextPaymentAttemptAt.toISOString() : null,
    };
  }

  /**
   * The purchasable tiers, for the in-app plan picker. Each tier reports its
   * configured Stripe price id (from env) and whether it's actually purchasable
   * on this deployment — a tier with no configured price id renders as
   * "contact us" rather than a dead Subscribe button.
   */
  listPlans() {
    return {
      billingConfigured: this.isConfigured(),
      plans: Object.entries(PAID_TIERS).map(([configVar, tier]) => {
        const priceId = this.config.get<string>(configVar) ?? null;
        return {
          key: tier.key,
          name: tier.name,
          features: tier.features,
          limits: tier.limits,
          priceId,
          purchasable: !!priceId && this.isConfigured(),
        };
      }),
    };
  }

  /**
   * Fetches the current unit amount (in the smallest currency unit, e.g.
   * cents) and billing interval for a set of Stripe Price ids — global
   * Stripe catalog data, not tied to any one company/tenant. Used by the
   * FleetHQ admin platform's executive dashboard (21-Admin-Platform/Overview.md)
   * to compute real MRR/ARR from the small, fixed set of configured price
   * ids (PAID_TIERS) rather than one lookup per subscribed company.
   *
   * Returns `null` per price id it can't resolve (deleted/archived price,
   * lookup failure) and an empty object entirely when billing isn't
   * configured — the caller reports `billingConfigured: false` rather than
   * this throwing, matching this service's existing "billing informs, never
   * hard-locks" tolerance for an unconfigured deployment.
   */
  async getPriceUnitAmounts(
    priceIds: string[],
  ): Promise<Record<string, { unitAmount: number; interval: string; currency: string } | null>> {
    if (!this.isConfigured() || priceIds.length === 0) return {};
    const stripe = this.getStripe();
    const results: Record<string, { unitAmount: number; interval: string; currency: string } | null> = {};
    await Promise.all(
      priceIds.map(async (priceId) => {
        try {
          const price = await stripe.prices.retrieve(priceId);
          results[priceId] =
            price.unit_amount != null && price.recurring
              ? { unitAmount: price.unit_amount, interval: price.recurring.interval, currency: price.currency }
              : null;
        } catch (err) {
          this.logger.warn(`Could not resolve Stripe price ${priceId} for the admin dashboard: ${err instanceof Error ? err.message : String(err)}`);
          results[priceId] = null;
        }
      }),
    );
    return results;
  }

  /**
   * Creates (or reuses) a Stripe Customer for this company, then a Checkout
   * Session in subscription mode for the given Price. The company's own
   * subscriptionStatus/planPriceId are only ever updated by the webhook
   * (`checkout.session.completed`), never optimistically here — Stripe
   * itself, not the client's redirect back, is the source of truth for
   * "did this actually succeed."
   *
   * `subscription_data.metadata.fleetosCompanyId` is what lets the webhook
   * handler resolve `customer.subscription.*` events straight back to a
   * Company without ever needing to query `companies` by an arbitrary
   * Stripe ID — see this class's own doc comment for why that lookup isn't
   * something RLS lets a request do before it already knows the companyId.
   */
  async createCheckoutSession(
    companyId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<{ url: string }> {
    const stripe = this.getStripe();
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { id: true, name: true, stripeCustomerId: true },
      }),
    );

    const customerId = company.stripeCustomerId ?? (await this.createCustomer(stripe, company.id, company.name));

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: company.id,
      subscription_data: { metadata: { fleetosCompanyId: company.id } },
    });

    if (!session.url) {
      throw new BadRequestException({ code: 'CHECKOUT_SESSION_FAILED', message: 'Stripe did not return a checkout URL.' });
    }
    return { url: session.url };
  }

  /** The Stripe-hosted portal for managing payment method, viewing invoices, or cancelling. */
  async createPortalSession(companyId: string, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.getStripe();
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { stripeCustomerId: true },
      }),
    );
    if (!company.stripeCustomerId) {
      throw new BadRequestException({
        code: 'NO_STRIPE_CUSTOMER',
        message: 'This company has no billing account yet — start a checkout session first.',
      });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  private async createCustomer(stripe: Stripe, companyId: string, companyName: string): Promise<string> {
    const customer = await stripe.customers.create({
      name: companyName,
      metadata: { fleetosCompanyId: companyId },
    });
    await this.prisma.withTenant(companyId, (tx) =>
      tx.company.update({ where: { id: companyId }, data: { stripeCustomerId: customer.id } }),
    );
    return customer.id;
  }

  /**
   * Verifies the Stripe signature against the raw request body, then applies
   * the event to the matching Company. Signature verification is what makes
   * this endpoint safe to leave unauthenticated (@Public()) — anyone can POST
   * to it, but only a payload actually signed with the real webhook secret
   * is ever acted on.
   */
  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException({ code: 'BILLING_NOT_CONFIGURED', message: 'No Stripe webhook secret configured.' });
    }
    const stripe = this.getStripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      // A bad/missing signature is a client error (400), not a server bug —
      // matches Stripe's own documented guidance, and keeps this out of
      // Sentry (HttpExceptionFilter only reports 5xx) since an invalid
      // signature here is either a misconfigured webhook secret or a
      // scanning bot, not a real application fault.
      throw new BadRequestException({
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: err instanceof Error ? err.message : 'Invalid Stripe webhook signature.',
      });
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(stripe, event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionEvent(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      // Stripe fires both `invoice.paid` and the older `invoice.payment_succeeded`
      // for the same successful charge — handling only `invoice.paid` (the
      // currently-recommended event) avoids double-counting/double-notifying
      // for what is a single real-world event.
      case 'invoice.paid':
        await this.handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      default:
        // Every other event type is either not relevant to what this service
        // tracks (payment methods, quotes, etc. — Stripe's own dashboard/
        // portal is the place to look at those) or is a duplicate of one
        // already handled above (`invoice.payment_succeeded` vs `invoice.paid`).
        break;
    }
  }

  private async handleCheckoutSessionCompleted(stripe: Stripe, session: Stripe.Checkout.Session): Promise<void> {
    const companyId = session.client_reference_id;
    if (!companyId || !session.customer || !session.subscription) return;
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    await this.syncSubscription(companyId, session.customer as string, subscription);
  }

  private async handleSubscriptionEvent(subscription: Stripe.Subscription): Promise<void> {
    const companyId = subscription.metadata?.fleetosCompanyId;
    if (!companyId) {
      this.logger.warn(`Received a subscription event with no fleetosCompanyId metadata (subscription ${subscription.id})`);
      return;
    }
    await this.syncSubscription(companyId, subscription.customer as string, subscription);
  }

  /**
   * `invoice.payment_failed` — the dunning-cycle-aware sibling of the coarser
   * `customer.subscription.updated` → PAST_DUE transition: this fires on
   * *every* failed attempt (not just the first), and carries the actual
   * retry schedule (`next_payment_attempt`), which PAST_DUE alone doesn't.
   * Company resolution reads `parent.subscription_details.metadata` directly
   * off the invoice — no extra Stripe API round-trip needed, since Stripe
   * snapshots the subscription's metadata onto the invoice at finalization.
   */
  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const companyId = invoice.parent?.subscription_details?.metadata?.fleetosCompanyId;
    if (!companyId) {
      this.logger.warn(`Received invoice.payment_failed with no fleetosCompanyId metadata (invoice ${invoice.id})`);
      return;
    }
    const nextAttempt = invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null;

    const { companyName, holders } = await this.prisma.withTenant(companyId, async (tx) => {
      await tx.company.update({
        where: { id: companyId },
        data: { paymentFailureCount: { increment: 1 }, lastPaymentFailedAt: new Date(), nextPaymentAttemptAt: nextAttempt },
      });
      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.payment_failed',
        title: 'A subscription payment failed',
        body: nextAttempt
          ? `Stripe was unable to charge your payment method and will automatically retry on ${nextAttempt.toLocaleDateString('en-AU')}. Update your payment method to avoid an interruption.`
          : 'Stripe was unable to charge your payment method and will not retry automatically. Update your payment method to keep your subscription active.',
        linkPath: '/billing',
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, holders };
    });

    // Emails are sent after the transaction commits, best-effort — mirroring
    // AuthMailService.sendNewDeviceLogin's call site: a slow/failed email
    // provider must never roll back the state change that raised it.
    this.sendBillingEmails(holders, (email, fullName) =>
      this.billingMail.sendPaymentFailed(email, fullName, companyName, nextAttempt),
    );
  }

  /**
   * `invoice.paid` — only notifies when this payment actually recovered the
   * company from a prior failure (paymentFailureCount > 0), never on a
   * routine on-time renewal, so "you're all paid up" doesn't fire every
   * billing cycle for the common case where nothing was ever wrong.
   */
  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    const companyId = invoice.parent?.subscription_details?.metadata?.fleetosCompanyId;
    if (!companyId) return;

    const result = await this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { paymentFailureCount: true, name: true } });
      const wasRecovering = company.paymentFailureCount > 0;
      await tx.company.update({ where: { id: companyId }, data: { paymentFailureCount: 0, nextPaymentAttemptAt: null } });
      if (!wasRecovering) return null;

      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.payment_recovered',
        title: 'Payment received — your subscription is back in good standing',
        body: 'Your most recent payment succeeded and your subscription is no longer past due.',
        linkPath: '/billing',
      });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, holders };
    });
    if (!result) return;

    this.sendBillingEmails(result.holders, (email, fullName) => this.billingMail.sendPaymentRecovered(email, fullName, result.companyName));
  }

  /** Fire-and-forget email fan-out to every billing:manage holder with an email address, skipping those without one (username is a login handle, not an inbox — same convention as the notification digest). */
  private sendBillingEmails(
    holders: { fullName: string; email: string | null }[],
    send: (email: string, fullName: string) => Promise<void>,
  ): void {
    for (const holder of holders) {
      if (!holder.email) continue;
      void send(holder.email, holder.fullName).catch((err) =>
        this.logger.warn(`Failed to send a billing notification email: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  private async syncSubscription(companyId: string, stripeCustomerId: string, subscription: Stripe.Subscription): Promise<void> {
    await this.prisma.withTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: {
          stripeCustomerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: mapStripeStatus(subscription.status),
          planPriceId: subscription.items.data[0]?.price.id ?? null,
        },
      }),
    );
  }
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return SubscriptionStatus.TRIALING;
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'past_due':
    case 'unpaid':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
    case 'incomplete_expired':
      return SubscriptionStatus.CANCELED;
    case 'incomplete':
    case 'paused':
      return SubscriptionStatus.NONE;
    default:
      return SubscriptionStatus.NONE;
  }
}
