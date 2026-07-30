import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

  async getStatus(companyId: string) {
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { subscriptionStatus: true, planPriceId: true, stripeCustomerId: true, trialEndsAt: true },
      }),
    );
    return {
      subscriptionStatus: company.subscriptionStatus,
      planPriceId: company.planPriceId,
      hasStripeCustomer: !!company.stripeCustomerId,
      billingConfigured: this.isConfigured(),
      trialEndsAt: company.trialEndsAt ? company.trialEndsAt.toISOString() : null,
      trialActive: isTrialActive(company.trialEndsAt),
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
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const companyId = session.client_reference_id;
        if (!companyId || !session.customer || !session.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        await this.syncSubscription(companyId, session.customer as string, subscription);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const companyId = subscription.metadata?.fleetosCompanyId;
        if (!companyId) {
          this.logger.warn(`Received a subscription event with no fleetosCompanyId metadata (subscription ${subscription.id})`);
          break;
        }
        await this.syncSubscription(companyId, subscription.customer as string, subscription);
        break;
      }
      default:
        // Every other event type is either not relevant to what this
        // service tracks (invoices, payment methods, etc. — Stripe's own
        // dashboard/portal is the place to look at those) or is implied by
        // the subscription-status events above (e.g. a failed invoice on a
        // subscription already shows up as that subscription's own status
        // going to `past_due` via customer.subscription.updated).
        break;
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
