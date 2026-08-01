import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
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
    private readonly systemPrisma: SystemPrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly billingMail: BillingMailService,
  ) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('STRIPE_SECRET_KEY');
  }

  /**
   * Checkout/portal redirect URLs come from the client, so constrain them to
   * this deployment's own app origin(s) rather than accepting any valid URL —
   * a mismatched success/return URL would otherwise bounce a just-paid
   * customer to an attacker-chosen site. Allowed origins are APP_BASE_URL plus
   * any CORS_ALLOWED_ORIGINS (the same origins the SPA is actually served
   * from). When neither is configured (local dev) the check is skipped, matching
   * this service's existing "billing informs, never hard-locks" tolerance.
   */
  private assertAppOriginUrl(rawUrl: string, field: string): void {
    const configured = [
      this.config.get<string>('APP_BASE_URL'),
      ...(this.config.get<string>('CORS_ALLOWED_ORIGINS')?.split(',') ?? []),
    ]
      .map((o) => o?.trim())
      .filter((o): o is string => !!o);
    if (configured.length === 0) return;

    let origin: string;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      throw new BadRequestException({ code: 'INVALID_REDIRECT_URL', message: `${field} is not a valid URL.` });
    }
    const allowed = new Set(configured.map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return o;
      }
    }));
    if (!allowed.has(origin)) {
      throw new BadRequestException({ code: 'REDIRECT_URL_NOT_ALLOWED', message: `${field} must point back to this application.` });
    }
  }

  /**
   * Auth/Billing Platform Phase 8 (GST / Australian tax invoicing): gates
   * `automatic_tax`/`tax_id_collection` on Checkout Sessions. Deliberately a
   * separate flag from `isConfigured()` — a deployment can have real Stripe
   * keys (billing works) without yet having enabled Stripe Tax and an
   * Australian GST registration in the Stripe Dashboard (a real business/
   * compliance step, not a code change — see 19-Billing/Billing_And_Subscriptions.md's
   * go-live checklist). Passing `automatic_tax: {enabled: true}` to Stripe
   * before that registration exists is a Stripe API error, so this must stay
   * opt-in rather than always-on.
   */
  isTaxEnabled(): boolean {
    return this.config.get<string>('STRIPE_TAX_ENABLED') === 'true';
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
  /** The Stripe price ids this deployment actually sells, from env (PAID_TIERS). Used to reject an unrecognised priceId before it reaches Stripe. */
  private configuredPriceIds(): Set<string> {
    const ids = new Set<string>();
    for (const configVar of Object.keys(PAID_TIERS)) {
      const priceId = this.config.get<string>(configVar);
      if (priceId) ids.add(priceId);
    }
    return ids;
  }

  async createCheckoutSession(
    companyId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<{ url: string }> {
    const stripe = this.getStripe();
    this.assertAppOriginUrl(successUrl, 'successUrl');
    this.assertAppOriginUrl(cancelUrl, 'cancelUrl');

    // Revenue-integrity guard: only ever start a checkout for a price this
    // deployment actually configures as a plan tier. Without this a stale,
    // mistyped, or client-cached priceId would be paid for at Stripe and then
    // resolve to no recognised tier — the customer pays and silently falls
    // back to the Free tier's entitlements. Reject it up front instead.
    if (!this.configuredPriceIds().has(priceId)) {
      throw new BadRequestException({
        code: 'UNKNOWN_PRICE_ID',
        message: 'That plan is not available. Refresh the page and choose a current plan.',
      });
    }

    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { id: true, name: true, abn: true, stripeCustomerId: true },
      }),
    );

    const customerId = company.stripeCustomerId ?? (await this.createCustomer(stripe, company.id, company.name, company.abn));

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: company.id,
        subscription_data: { metadata: { fleetosCompanyId: company.id } },
        // GST/Australian tax invoicing (Phase 8) — see isTaxEnabled()'s own doc
        // comment for why this can't be unconditional. `tax_id_collection` lets
        // a company add/confirm its ABN at checkout even if it wasn't already
        // on file (createCustomer already attaches one if it was).
        ...(this.isTaxEnabled() ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
      },
      // Idempotency key so a double-click or a client timeout-retry reuses the
      // same Checkout Session instead of opening a second, independent one. The
      // hour bucket lets a genuinely new checkout for the same plan proceed
      // later while collapsing rapid retries of the same action.
      { idempotencyKey: `checkout:${company.id}:${priceId}:${Math.floor(Date.now() / 3_600_000)}` },
    );

    if (!session.url) {
      throw new BadRequestException({ code: 'CHECKOUT_SESSION_FAILED', message: 'Stripe did not return a checkout URL.' });
    }
    return { url: session.url };
  }

  /** The Stripe-hosted portal for managing payment method, viewing invoices, or cancelling. */
  async createPortalSession(companyId: string, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.getStripe();
    this.assertAppOriginUrl(returnUrl, 'returnUrl');
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

  /**
   * `abn` (Phase 4's registration-depth field, already ABR-checksum-validated
   * by `IsAbn`) is attached as a Stripe `au_abn` tax ID at Customer-creation
   * time so it appears on Stripe's own GST tax invoices — this is independent
   * of `isTaxEnabled()`/`automatic_tax`, since attaching a known tax ID never
   * requires the account to have Stripe Tax enabled. Only covers the
   * moment the customer is first created — a company that adds its ABN
   * later doesn't get it retroactively attached here; they can add one
   * themselves via the Stripe billing portal's own tax ID field instead.
   */
  private async createCustomer(stripe: Stripe, companyId: string, companyName: string, abn: string | null): Promise<string> {
    const customer = await stripe.customers.create(
      {
        name: companyName,
        metadata: { fleetosCompanyId: companyId },
        ...(abn ? { tax_id_data: [{ type: 'au_abn', value: abn.replace(/\s/g, '') }] } : {}),
      },
      // Idempotency key on the company id: if the DB write below fails after
      // Stripe created the customer, the retry reuses that same customer
      // rather than orphaning a duplicate for this company.
      { idempotencyKey: `customer:${companyId}` },
    );
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

    // Idempotency: Stripe documents that a webhook can be delivered more than
    // once, and several handlers here are non-idempotent (e.g. incrementing
    // paymentFailureCount). Record the event id first; if it's already been
    // seen, this is a duplicate delivery and we stop. Recorded via the
    // privileged fleetos_auth role since an event isn't tenant-scoped until its
    // handler resolves a company from the payload metadata.
    if (await this.alreadyProcessed(event)) return;

    // `event.created` is always present on a real Stripe event; default to now
    // rather than risk writing an Invalid Date if a malformed payload omits it.
    const eventCreatedAt = event.created ? new Date(event.created * 1000) : new Date();
    await this.dispatchWebhookEvent(stripe, event, eventCreatedAt);
  }

  private async dispatchWebhookEvent(stripe: Stripe, event: Stripe.Event, eventCreatedAt: Date): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(stripe, event.data.object as Stripe.Checkout.Session, eventCreatedAt);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionEvent(event.data.object as Stripe.Subscription, eventCreatedAt);
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
      case 'charge.refunded':
        await this.handleChargeRefunded(event.data.object as Stripe.Charge);
        break;
      default:
        // Every other event type is either not relevant to what this service
        // tracks (payment methods, quotes, etc. — Stripe's own dashboard/
        // portal is the place to look at those) or is a duplicate of one
        // already handled above (`invoice.payment_succeeded` vs `invoice.paid`).
        break;
    }
  }

  /**
   * Records the event id in the idempotency ledger. Returns true if it was
   * already there (duplicate delivery → skip). The insert races safely: if two
   * concurrent deliveries of the same event both try to insert, the second
   * gets a unique-constraint violation (P2002) and is treated as a duplicate.
   */
  private async alreadyProcessed(event: Stripe.Event): Promise<boolean> {
    try {
      await this.systemPrisma.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
      return false;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log(`Skipping duplicate Stripe webhook delivery (event ${event.id})`);
        return true;
      }
      throw err;
    }
  }

  /**
   * `charge.refunded` — a refund issued from the Stripe Dashboard. It doesn't
   * change entitlements on its own (a cancellation, if any, arrives as its own
   * `customer.subscription.*` event and is handled there), but the account's
   * billing:manage holders should know it happened. Company is resolved from
   * the charge's customer metadata; no-op if it can't be.
   */
  private async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const companyId = typeof charge.metadata?.fleetosCompanyId === 'string' ? charge.metadata.fleetosCompanyId : undefined;
    if (!companyId) {
      this.logger.log(`Received charge.refunded with no resolvable company (charge ${charge.id})`);
      return;
    }
    await this.prisma.withTenant(companyId, (tx) =>
      this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.refunded',
        title: 'A refund was processed on your account',
        body: 'A refund was issued to your payment method. If this affects your subscription you will see the change reflected on your billing page.',
        linkPath: '/billing',
      }),
    );
  }

  private async handleCheckoutSessionCompleted(stripe: Stripe, session: Stripe.Checkout.Session, eventCreatedAt: Date): Promise<void> {
    const companyId = session.client_reference_id;
    if (!companyId || !session.customer || !session.subscription) return;
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    await this.syncSubscription(companyId, session.customer as string, subscription, eventCreatedAt);
  }

  private async handleSubscriptionEvent(subscription: Stripe.Subscription, eventCreatedAt: Date): Promise<void> {
    const companyId = subscription.metadata?.fleetosCompanyId;
    if (!companyId) {
      this.logger.warn(`Received a subscription event with no fleetosCompanyId metadata (subscription ${subscription.id})`);
      return;
    }
    await this.syncSubscription(companyId, subscription.customer as string, subscription, eventCreatedAt);
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

  private async syncSubscription(
    companyId: string,
    stripeCustomerId: string,
    subscription: Stripe.Subscription,
    eventCreatedAt: Date,
  ): Promise<void> {
    await this.prisma.withTenant(companyId, async (tx) => {
      // Ordering guard: Stripe can deliver subscription events out of order, so
      // a retried, older `customer.subscription.updated` must not clobber a
      // newer state that already landed. Skip anything not strictly newer than
      // the last applied event, and always advance the watermark.
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { lastStripeEventAt: true } });
      if (company.lastStripeEventAt && eventCreatedAt <= company.lastStripeEventAt) {
        this.logger.log(`Skipping out-of-order subscription event for company ${companyId} (event ${eventCreatedAt.toISOString()} <= last ${company.lastStripeEventAt.toISOString()})`);
        return;
      }
      await tx.company.update({
        where: { id: companyId },
        data: {
          stripeCustomerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: mapStripeStatus(subscription.status),
          planPriceId: subscription.items.data[0]?.price.id ?? null,
          lastStripeEventAt: eventCreatedAt,
        },
      });
    });
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
