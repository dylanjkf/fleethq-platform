/* eslint-disable max-lines */
// Pre-existing oversized service (predates this security port; not modified by
// it). Grandfathered to keep the max-lines rule active for the rest of the repo;
// a proper split is tracked as separate follow-up work.
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { BillingMailService } from './billing-mail.service';
import { PAID_TIERS, isSubscriptionActive, isTrialActive } from './plans';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How close to `trialEndsAt` the native (no-card) trial reminder fires. */
const TRIAL_REMINDER_DAYS = 3;

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
  /**
   * In-process cache of the auto-created Billing Portal Configuration id (see
   * `getPortalConfigurationId`). Prevents rebuilding the configuration on every
   * portal-session request; a deployment that sets `STRIPE_PORTAL_CONFIGURATION_ID`
   * bypasses this path entirely.
   */
  private cachedPortalConfigurationId: string | null = null;

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
  async listPlans() {
    const perAssetPriceId = this.perAssetPriceId() ?? null;
    const settings = await this.getBillingSettings();
    // The per-asset plan is the headline product under the per-asset model: one
    // plan, priced per active asset, cap = purchased quantity. Reported first so
    // the picker leads with it. `pricePerAssetCents` comes from billing_settings
    // (one source of truth), not a hardcoded literal.
    const perAssetPlan = {
      key: 'per_asset',
      name: 'Per-asset',
      features: ['core', 'forms', 'intelligence', 'warehouse'] as const,
      limits: { maxOperators: null, maxAssets: null },
      priceId: perAssetPriceId,
      purchasable: !!perAssetPriceId && this.isConfigured(),
      perAsset: true as const,
      pricePerAssetCents: settings.pricePerAssetCents,
      currency: settings.currency,
      billingInterval: settings.billingInterval,
    };
    return {
      billingConfigured: this.isConfigured(),
      plans: [
        perAssetPlan,
        // Legacy fixed tiers remain resolvable for any grandfathered tenant, but
        // are only offered in the picker when their price id is configured.
        ...Object.entries(PAID_TIERS)
          .map(([configVar, tier]) => {
            const priceId = this.config.get<string>(configVar) ?? null;
            return {
              key: tier.key,
              name: tier.name,
              features: tier.features,
              limits: tier.limits,
              priceId,
              purchasable: !!priceId && this.isConfigured(),
              perAsset: false as const,
            };
          })
          .filter((p) => p.purchasable),
      ],
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
  /** The Stripe price ids this deployment actually sells, from env (PAID_TIERS + the per-asset price). Used to reject an unrecognised priceId before it reaches Stripe. */
  private configuredPriceIds(): Set<string> {
    const ids = new Set<string>();
    for (const configVar of Object.keys(PAID_TIERS)) {
      const priceId = this.config.get<string>(configVar);
      if (priceId) ids.add(priceId);
    }
    const perAsset = this.perAssetPriceId();
    if (perAsset) ids.add(perAsset);
    return ids;
  }

  /** The Stripe Price id for the per-asset plan ($19 AUD/asset/month), if configured. */
  private perAssetPriceId(): string | undefined {
    return this.config.get<string>('STRIPE_PRICE_PER_ASSET');
  }

  /**
   * The single-row per-asset billing config (price_per_asset_cents, currency,
   * interval, gst_rate, abn). `billing_settings` is global platform config with
   * no RLS, so it resolves the same on any connection; falls back to the launch
   * defaults if the row is somehow absent (e.g. a DB restored before the seed).
   */
  async getBillingSettings(): Promise<{ pricePerAssetCents: number; currency: string; billingInterval: string; gstRate: number; abn: string | null }> {
    const row = await this.prisma.billingSettings.findUnique({ where: { id: 1 } });
    return {
      pricePerAssetCents: row?.pricePerAssetCents ?? 1900,
      currency: row?.currency ?? 'AUD',
      billingInterval: row?.billingInterval ?? 'month',
      gstRate: row?.gstRate ?? 0.1,
      abn: row?.abn ?? null,
    };
  }

  async createCheckoutSession(
    companyId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
    quantity = 1,
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

    // For the per-asset price the checkout quantity is the number of asset slots
    // being purchased — the value that becomes the company's hard cap. It must
    // be a whole number ≥ 1; for a fixed-tier price the quantity is always 1
    // (one subscription, not N seats), so ignore any client-supplied value there
    // rather than let it multiply the tier's price.
    const isPerAsset = priceId === this.perAssetPriceId();
    const lineQuantity = isPerAsset ? this.assertValidQuantity(quantity) : 1;

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
        // Per-asset lets the customer adjust the slot count on Stripe's own
        // Checkout page (a natural place to pick their fleet size); a fixed tier
        // is a single non-adjustable line.
        line_items: [
          isPerAsset
            ? { price: priceId, quantity: lineQuantity, adjustable_quantity: { enabled: true, minimum: 1 } }
            : { price: priceId, quantity: lineQuantity },
        ],
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
      // later while collapsing rapid retries of the same action. Quantity is in
      // the key so changing the requested slot count opens a fresh session.
      { idempotencyKey: `checkout:${company.id}:${priceId}:${lineQuantity}:${Math.floor(Date.now() / 3_600_000)}` },
    );

    if (!session.url) {
      throw new BadRequestException({ code: 'CHECKOUT_SESSION_FAILED', message: 'Stripe did not return a checkout URL.' });
    }
    return { url: session.url };
  }

  /** Validates a per-asset slot count: a whole number in [1, 100000]. Throws a clear 400 otherwise. */
  private assertValidQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
      throw new BadRequestException({
        code: 'INVALID_ASSET_QUANTITY',
        message: 'The number of asset slots must be a whole number of at least 1.',
      });
    }
    return quantity;
  }

  /**
   * Changes the purchased asset-slot count on an existing per-asset
   * subscription (the customer's "buy more / release" action). Stripe prorates
   * the change (`create_prorations`): buying more slots mid-cycle is charged
   * pro-rata immediately; releasing slots credits the unused remainder.
   *
   * Downgrade guard (the security/revenue-critical rule): a company can never
   * set its paid quantity BELOW the assets it currently has live — that would
   * put it permanently over its own cap. To reduce the count it must first
   * archive assets. This blocks-new-only model means quantity only drops by an
   * explicit action that's already valid against current usage; it never strands
   * data. The webhook (`customer.subscription.updated`) is what writes the new
   * `assetQuantity` — Stripe stays source of truth — so this method deliberately
   * does NOT optimistically change the stored cap: an increase only takes effect
   * once Stripe confirms it (fail-closed), and the guard already ensures a
   * decrease can't drop below live usage.
   */
  async changeAssetQuantity(companyId: string, newQuantity: number, actorUserId?: string): Promise<{ quantity: number }> {
    const stripe = this.getStripe();
    const quantity = this.assertValidQuantity(newQuantity);
    const perAssetPriceId = this.perAssetPriceId();

    const { subscriptionId, currentQuantity, liveAssets } = await this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { stripeSubscriptionId: true, planPriceId: true, subscriptionStatus: true, assetQuantity: true },
      });
      if (!perAssetPriceId || company.planPriceId !== perAssetPriceId || !isSubscriptionActive(company.subscriptionStatus) || !company.stripeSubscriptionId) {
        throw new BadRequestException({
          code: 'NOT_ON_PER_ASSET_PLAN',
          message: 'This company is not on the per-asset plan. Start a per-asset checkout first.',
        });
      }
      const liveAssets = await tx.asset.count({ where: { archivedAt: null } });
      return { subscriptionId: company.stripeSubscriptionId, currentQuantity: company.assetQuantity ?? 0, liveAssets };
    });

    if (quantity < liveAssets) {
      throw new BadRequestException({
        code: 'QUANTITY_BELOW_USAGE',
        message: `You currently have ${liveAssets} active assets. Archive assets down to ${quantity} or fewer before reducing your paid quantity to ${quantity}.`,
        liveAssets,
        requested: quantity,
      });
    }

    // Update the single subscription item's quantity with proration. Retrieve
    // the subscription to find the item id (the per-asset subscription has one
    // recurring line). Idempotency key collapses a double-submit of the same
    // target quantity within the hour into one Stripe write.
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data[0];
    if (!item) {
      throw new BadRequestException({ code: 'SUBSCRIPTION_ITEM_MISSING', message: 'Could not find the subscription line item to update.' });
    }
    await stripe.subscriptions.update(
      subscriptionId,
      { items: [{ id: item.id, quantity }], proration_behavior: 'create_prorations' },
      { idempotencyKey: `qty:${companyId}:${quantity}:${Math.floor(Date.now() / 3_600_000)}` },
    );

    // Append-only evidence of the change (who, from→to). Written on the tenant
    // connection since this runs inside an authenticated request, not a webhook.
    await this.prisma.withTenant(companyId, (tx) =>
      tx.billingAuditLog.create({
        data: {
          companyId,
          eventType: 'QUANTITY_CHANGED',
          actorUserId: actorUserId ?? null,
          detail: { from: currentQuantity, to: quantity, liveAssets, via: 'customer' },
        },
      }),
    );

    return { quantity };
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
    // Revenue-integrity guard (parity with createCheckoutSession's allowlist):
    // pin the portal to a Billing Portal Configuration whose plan-switching is
    // restricted to the SAME prices we sell at checkout. Without an explicit
    // `configuration`, Stripe uses the Dashboard default config — and if
    // plan-switching is enabled there, a customer could switch to ANY price in
    // the account, bypassing the server-side checkout allowlist entirely. This
    // must not depend on Dashboard state, so we build/reuse the configuration in
    // application code.
    const configuration = await this.getPortalConfigurationId(stripe);
    const session = await stripe.billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: returnUrl,
      ...(configuration ? { configuration } : {}),
    });
    return { url: session.url };
  }

  /**
   * Resolves the Stripe Billing Portal Configuration id whose `subscription_update`
   * feature is locked to this deployment's checkout allowlist (`configuredPriceIds`),
   * so a customer using the portal can only ever switch between the same tiers
   * they could buy at checkout — never an arbitrary account price.
   *
   * Resolution order (idempotent — never creates a new configuration per call):
   *  1. `STRIPE_PORTAL_CONFIGURATION_ID` env var, if set — the recommended
   *     production posture (a config managed once, out of band).
   *  2. A previously-created fleetos-managed configuration matching the current
   *     allowlist fingerprint — found via `configurations.list` (survives process
   *     restarts) or the in-process cache.
   *  3. Otherwise, create one (with an idempotency key keyed on the allowlist
   *     fingerprint so concurrent first-requests collapse to a single config).
   *
   * When the allowlist is empty (no price ids configured) or a price can't be
   * resolved to its product, `subscription_update` is DISABLED rather than left
   * open — the safe, more-restrictive default.
   */
  private async getPortalConfigurationId(stripe: Stripe): Promise<string | undefined> {
    const explicit = this.config.get<string>('STRIPE_PORTAL_CONFIGURATION_ID');
    if (explicit) return explicit;
    if (this.cachedPortalConfigurationId) return this.cachedPortalConfigurationId;

    const priceIds = [...this.configuredPriceIds()];
    const fingerprint = this.portalAllowlistFingerprint(priceIds);

    // Reuse a matching fleetos-managed configuration if one already exists, so a
    // process restart (which clears the in-memory cache and expires the 24h
    // idempotency key) doesn't accumulate a new configuration each day.
    try {
      const existing = await stripe.billingPortal.configurations.list({ limit: 100 });
      const match = existing.data.find((c) => c.active && c.metadata?.fleetosPortalFingerprint === fingerprint);
      if (match) {
        this.cachedPortalConfigurationId = match.id;
        return match.id;
      }
    } catch (err) {
      this.logger.warn(`Could not list Stripe billing portal configurations for reuse: ${err instanceof Error ? err.message : String(err)}`);
    }

    const products = await this.buildPortalAllowedProducts(stripe, priceIds);
    const configuration = await stripe.billingPortal.configurations.create(
      {
        business_profile: this.portalBusinessProfile(),
        features: {
          customer_update: { enabled: true, allowed_updates: ['email', 'address', 'phone', 'tax_id'] },
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
          subscription_update:
            products.length > 0
              ? { enabled: true, default_allowed_updates: ['price'], products, proration_behavior: 'create_prorations' }
              : { enabled: false },
        },
        metadata: { fleetosPortalFingerprint: fingerprint },
      },
      // Idempotency key on the allowlist fingerprint: concurrent first-requests
      // (before the cache is warm) reuse one configuration instead of racing to
      // create several. A changed allowlist yields a new fingerprint → new key.
      { idempotencyKey: `portal-config:${fingerprint}` },
    );
    this.cachedPortalConfigurationId = configuration.id;
    return configuration.id;
  }

  /** A stable fingerprint of the sold price ids, order-independent, so a portal configuration can be matched/reused for a given allowlist. */
  private portalAllowlistFingerprint(priceIds: string[]): string {
    return [...priceIds].sort().join(',') || 'none';
  }

  /**
   * Groups the allowlisted price ids by their Stripe product, the shape
   * `subscription_update.products` requires. Each price is retrieved to resolve
   * its product; an unresolvable price is skipped (logged) rather than left to
   * silently widen the allowlist.
   */
  private async buildPortalAllowedProducts(
    stripe: Stripe,
    priceIds: string[],
  ): Promise<Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate.Product[]> {
    const byProduct = new Map<string, string[]>();
    for (const priceId of priceIds) {
      try {
        const price = await stripe.prices.retrieve(priceId);
        const productId = typeof price.product === 'string' ? price.product : price.product?.id;
        if (!productId) continue;
        const prices = byProduct.get(productId) ?? [];
        prices.push(priceId);
        byProduct.set(productId, prices);
      } catch (err) {
        this.logger.warn(`Could not resolve Stripe price ${priceId} to a product for the billing portal allowlist: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return [...byProduct.entries()].map(([product, prices]) => ({ product, prices }));
  }

  /** Portal business info (headline is always safe; policy links are attached only when a URL is resolvable, since Stripe stores them verbatim). */
  private portalBusinessProfile(): Stripe.BillingPortal.ConfigurationCreateParams.BusinessProfile {
    const appBase = this.config.get<string>('APP_BASE_URL')?.replace(/\/$/, '');
    const privacy = this.config.get<string>('PRIVACY_POLICY_URL') ?? (appBase ? `${appBase}/privacy` : undefined);
    const terms = this.config.get<string>('TERMS_OF_SERVICE_URL') ?? (appBase ? `${appBase}/terms` : undefined);
    return {
      headline: 'Manage your FleetOS subscription',
      ...(privacy ? { privacy_policy_url: privacy } : {}),
      ...(terms ? { terms_of_service_url: terms } : {}),
    };
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
      // A subscription Stripe has paused (e.g. a paused dunning outcome, or an
      // admin/portal pause) stops billing but is a distinct state the account's
      // billing:manage holders should be told about — sync the status AND notify,
      // rather than letting it fold silently into the generic update handler.
      case 'customer.subscription.paused':
        await this.handleSubscriptionPaused(event.data.object as Stripe.Subscription, eventCreatedAt);
        break;
      // Stripe's own trial (subscription in `trialing`) is about to end and
      // convert to a paid charge — nudge billing:manage holders so a conversion
      // is never a surprise. Distinct from FleetOS's native no-card trial
      // reminder (the scheduled `remindTrialEnding` job).
      case 'customer.subscription.trial_will_end':
        await this.handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;
      // A chargeback. Revenue-critical and time-boxed (Stripe imposes a response
      // deadline), so this must never be silent — notify AND email urgently.
      case 'charge.dispute.created':
        await this.handleChargeDisputeCreated(stripe, event.data.object as Stripe.Dispute);
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

  /**
   * `customer.subscription.paused` — Stripe has paused the subscription (no
   * further charges until it resumes). Advances the stored subscriptionStatus
   * through the same ordering-guarded `syncSubscription` as any other
   * subscription event, then notifies + emails billing:manage holders so a
   * paused account isn't a silent surprise.
   */
  private async handleSubscriptionPaused(subscription: Stripe.Subscription, eventCreatedAt: Date): Promise<void> {
    const companyId = subscription.metadata?.fleetosCompanyId;
    if (!companyId) {
      this.logger.warn(`Received customer.subscription.paused with no fleetosCompanyId metadata (subscription ${subscription.id})`);
      return;
    }
    await this.syncSubscription(companyId, subscription.customer as string, subscription, eventCreatedAt);

    const { companyName, holders } = await this.prisma.withTenant(companyId, async (tx) => {
      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.subscription_paused',
        title: 'Your subscription has been paused',
        body: 'Your FleetOS subscription is paused and will not be billed until it resumes. Some paid features may be unavailable while it is paused — reach out if this was unexpected.',
        linkPath: '/billing',
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, holders };
    });

    this.sendBillingEmails(holders, (email, fullName) => this.billingMail.sendSubscriptionPaused(email, fullName, companyName));
  }

  /**
   * `customer.subscription.trial_will_end` — Stripe fires this ~3 days before a
   * `trialing` subscription converts to a paid charge. Notifies + emails
   * billing:manage holders so the upcoming charge is expected. Purely
   * informational: it changes no stored state (the eventual conversion arrives
   * as its own `customer.subscription.updated`).
   */
  private async handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
    const companyId = subscription.metadata?.fleetosCompanyId;
    if (!companyId) {
      this.logger.warn(`Received customer.subscription.trial_will_end with no fleetosCompanyId metadata (subscription ${subscription.id})`);
      return;
    }
    const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;

    const { companyName, holders } = await this.prisma.withTenant(companyId, async (tx) => {
      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.trial_will_end',
        title: 'Your trial is ending soon',
        body: trialEnd
          ? `Your subscription trial ends on ${trialEnd.toLocaleDateString('en-AU')}, after which your payment method will be charged. Review your plan or update your payment details before then.`
          : 'Your subscription trial is ending soon, after which your payment method will be charged. Review your plan or update your payment details before then.',
        linkPath: '/billing',
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, holders };
    });

    this.sendBillingEmails(holders, (email, fullName) => this.billingMail.sendTrialWillEnd(email, fullName, companyName, trialEnd));
  }

  /**
   * `charge.dispute.created` — a cardholder has opened a dispute (chargeback).
   * Revenue-critical and time-boxed, so it is raised URGENTLY (in-app + email)
   * to every billing:manage holder; it never silently no-ops on a resolvable
   * company. Company is resolved from the disputed charge's metadata, falling
   * back to the charge's customer metadata (always set at customer creation).
   */
  private async handleChargeDisputeCreated(stripe: Stripe, dispute: Stripe.Dispute): Promise<void> {
    const companyId = await this.resolveCompanyIdFromCharge(stripe, dispute.charge);
    if (!companyId) {
      this.logger.warn(`Received charge.dispute.created with no resolvable company (dispute ${dispute.id})`);
      return;
    }
    const amount = this.formatMinorAmount(dispute.amount, dispute.currency);
    const dueBy = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null;

    const { companyName, holders } = await this.prisma.withTenant(companyId, async (tx) => {
      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.dispute_created',
        title: 'Urgent: a payment was disputed (chargeback)',
        body: dueBy
          ? `A cardholder disputed a ${amount} payment. Submit evidence in Stripe before ${dueBy.toLocaleDateString('en-AU')} or the amount plus a dispute fee will be lost.`
          : `A cardholder disputed a ${amount} payment. Respond in Stripe before the deadline or the amount plus a dispute fee will be lost.`,
        linkPath: '/billing',
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, holders };
    });

    this.sendBillingEmails(holders, (email, fullName) => this.billingMail.sendDisputeCreated(email, fullName, companyName, amount, dueBy));
  }

  /**
   * Resolves the owning company for a charge (used by the dispute handler):
   * the charge's own `fleetosCompanyId` metadata if present, else the charge's
   * customer metadata (set on every customer at creation). Best-effort — returns
   * undefined if the charge/customer can't be fetched.
   */
  private async resolveCompanyIdFromCharge(stripe: Stripe, charge: string | Stripe.Charge | null): Promise<string | undefined> {
    if (!charge) return undefined;
    try {
      const full = typeof charge === 'string' ? await stripe.charges.retrieve(charge, { expand: ['customer'] }) : charge;
      const fromCharge = typeof full.metadata?.fleetosCompanyId === 'string' ? full.metadata.fleetosCompanyId : undefined;
      if (fromCharge) return fromCharge;
      const customer = full.customer;
      if (customer && typeof customer !== 'string' && !('deleted' in customer && customer.deleted)) {
        const fromCustomer = (customer as Stripe.Customer).metadata?.fleetosCompanyId;
        if (typeof fromCustomer === 'string') return fromCustomer;
      }
      return undefined;
    } catch (err) {
      this.logger.warn(`Could not resolve a company from charge ${typeof charge === 'string' ? charge : charge.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Format a Stripe minor-unit amount (e.g. cents) as a currency string for a customer-facing message. */
  private formatMinorAmount(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
    } catch {
      return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
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

  /**
   * Native (no-card) free-trial reminder for one company: if this company's
   * `trialEndsAt` falls inside the reminder window and it hasn't already
   * subscribed, notify + email its billing:manage holders once.
   *
   * Idempotent by design (safe to run daily): a `billing.trial_ending`
   * notification created since the window opened is the "already reminded"
   * marker, so a company is nudged once per trial window, not every tick — the
   * same "the alert mark makes a re-run a no-op" shape the compliance/maintenance
   * sweeps use. Returns the number of holders reminded (0 = nothing to do).
   */
  async remindTrialEnding(companyId: string, now: Date = new Date()): Promise<number> {
    const windowMs = TRIAL_REMINDER_DAYS * DAY_MS;
    const result = await this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { name: true, trialEndsAt: true, subscriptionStatus: true },
      });
      const trialEndsAt = company.trialEndsAt;
      if (!trialEndsAt) return null;
      const msLeft = trialEndsAt.getTime() - now.getTime();
      // Only the final window, and never after it has already lapsed.
      if (msLeft <= 0 || msLeft > windowMs) return null;
      // A company that has already taken up a Stripe subscription doesn't need a
      // "your free trial ends" nudge — the native trial only matters while there
      // is no paid subscription at all.
      if (company.subscriptionStatus !== SubscriptionStatus.NONE) return null;
      // Idempotency: one reminder per trial window.
      const windowStart = new Date(trialEndsAt.getTime() - windowMs);
      const already = await tx.notification.findFirst({
        where: { type: 'billing.trial_ending', createdAt: { gte: windowStart } },
        select: { id: true },
      });
      if (already) return null;

      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.BILLING_MANAGE, {
        type: 'billing.trial_ending',
        title: 'Your free trial ends soon',
        body: `Your FleetOS free trial ends on ${trialEndsAt.toLocaleDateString('en-AU')}. Choose a plan before then to keep full access to your fleet.`,
        linkPath: '/billing',
      });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.BILLING_MANAGE);
      return { companyName: company.name, trialEndsAt, holders };
    });
    if (!result) return 0;

    this.sendBillingEmails(result.holders, (email, fullName) =>
      this.billingMail.sendTrialEndingReminder(email, fullName, result.companyName, result.trialEndsAt),
    );
    return result.holders.length;
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
      // Per-asset billing: the purchased quantity (subscription item quantity)
      // is the company's hard asset cap. Capture it whenever the subscription is
      // on the per-asset price; clear it (→ null) when it isn't, so switching off
      // the per-asset plan doesn't leave a stale cap behind. This is THE point
      // where Stripe's authoritative quantity flows into FleetOS's own cap.
      const item = subscription.items.data[0];
      const priceId = item?.price.id ?? null;
      const perAssetPriceId = this.perAssetPriceId();
      const onPerAsset = !!perAssetPriceId && priceId === perAssetPriceId;
      const assetQuantity = onPerAsset ? (item?.quantity ?? null) : null;
      await tx.company.update({
        where: { id: companyId },
        data: {
          stripeCustomerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: mapStripeStatus(subscription.status),
          planPriceId: priceId,
          assetQuantity,
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
