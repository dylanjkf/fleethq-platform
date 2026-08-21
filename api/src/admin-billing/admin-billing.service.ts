import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import Stripe from 'stripe';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { BillingService } from '../billing/billing.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { RefundDto } from './dto/refund.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { ManualInvoiceDto } from './dto/manual-invoice.dto';
import { CreditNoteDto } from './dto/credit-note.dto';
import { RetryPaymentDto } from './dto/retry-payment.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { ReleaseContractDto } from './dto/release-contract.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { AuditTrailQueryDto } from './dto/audit-trail-query.dto';

/**
 * FleetHQ staff-facing billing operations layered on top of the existing
 * customer BillingService/Stripe integration (21-Admin-Platform/Overview.md,
 * Phase 4). Every method here only ever reads/acts on Stripe objects and the
 * two Stripe id columns on Company (stripeCustomerId/stripeSubscriptionId) —
 * `Company.subscriptionStatus`/`planPriceId` remain exclusively the webhook
 * handler's responsibility (`BillingService.handleWebhookEvent` →
 * `syncSubscription`). An admin refunding an invoice or cancelling a
 * subscription changes Stripe's state; the next webhook delivery is what
 * reflects that back onto the Company row, exactly as it would for a
 * customer-initiated change. This keeps "Stripe is the source of truth" true
 * for every write path, not just the customer-facing one.
 */
@Injectable()
export class AdminBillingService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
    private readonly billing: BillingService,
  ) {}

  /**
   * A deterministic Stripe idempotency key for an admin-initiated financial
   * write, mirroring the customer-facing `BillingService`'s keys. Keyed on the
   * acting admin, the action, the target object id, and a coarse per-minute time
   * bucket — so a double-click / client retry within the same minute reuses the
   * same Stripe request (one refund, one invoice) instead of issuing a second
   * real financial event, while a genuinely new action a minute later proceeds.
   */
  private idempotencyKey(action: string, targetId: string, adminUserId: string | null | undefined, now: Date = new Date()): string {
    const minuteBucket = Math.floor(now.getTime() / 60_000);
    return `admin-billing:${adminUserId ?? 'unknown'}:${action}:${targetId}:${minuteBucket}`;
  }

  private async requireCompany(companyId: string) {
    const company = await this.adminPrisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, stripeCustomerId: true, stripeSubscriptionId: true, subscriptionStatus: true, planPriceId: true, trialEndsAt: true },
    });
    if (!company) throw new NotFoundException({ code: 'ORGANISATION_NOT_FOUND', message: 'Organisation not found.' });
    return company;
  }

  private requireStripeCustomerId(company: { stripeCustomerId: string | null }): string {
    if (!company.stripeCustomerId) {
      throw new BadRequestException({ code: 'NO_STRIPE_CUSTOMER', message: 'This organisation has no billing account yet.' });
    }
    return company.stripeCustomerId;
  }

  private requireStripeSubscriptionId(company: { stripeSubscriptionId: string | null }): string {
    if (!company.stripeSubscriptionId) {
      throw new BadRequestException({ code: 'NO_STRIPE_SUBSCRIPTION', message: 'This organisation has no active subscription.' });
    }
    return company.stripeSubscriptionId;
  }

  /**
   * Confirms the invoice an admin is about to act on actually belongs to
   * this organisation's Stripe customer — the route only scopes by
   * companyId in the URL, so without this check an admin permitted to
   * operate on Company A could pass an arbitrary invoice id belonging to
   * Company B and act on it cross-tenant.
   */
  private async requireOwnedInvoice(stripe: Stripe, invoiceId: string, stripeCustomerId: string): Promise<Stripe.Invoice> {
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments.data.payment.payment_intent'] });
    } catch {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    }
    const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (invoiceCustomerId !== stripeCustomerId) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    }
    return invoice;
  }

  /**
   * Newer Stripe API versions moved `payment_intent` off Invoice itself and
   * onto the invoice's `payments` list (each a Stripe InvoicePayment) — see
   * InvoicePayments.d.ts. Resolves the reference (payment_intent or, for the
   * rarer out-of-band-charge case, charge) from the invoice's default/paid
   * payment, which is what a refund needs to target.
   */
  private resolvePaymentReference(invoice: Stripe.Invoice): { paymentIntentId?: string; chargeId?: string } {
    const payment = invoice.payments?.data.find((p) => p.status === 'paid') ?? invoice.payments?.data.find((p) => p.is_default);
    if (!payment) return {};
    const paymentIntentId = typeof payment.payment.payment_intent === 'string' ? payment.payment.payment_intent : payment.payment.payment_intent?.id;
    const chargeId = typeof payment.payment.charge === 'string' ? payment.payment.charge : payment.payment.charge?.id;
    return { paymentIntentId, chargeId };
  }

  async getStatus(companyId: string) {
    const company = await this.requireCompany(companyId);
    const billingConfigured = this.billing.isConfigured();
    let subscription: Stripe.Subscription | null = null;
    if (billingConfigured && company.stripeSubscriptionId) {
      const stripe = this.billing.getStripeClient();
      subscription = await stripe.subscriptions.retrieve(company.stripeSubscriptionId);
    }
    return {
      billingConfigured,
      subscriptionStatus: company.subscriptionStatus,
      planPriceId: company.planPriceId,
      trialEndsAt: company.trialEndsAt,
      hasStripeCustomer: !!company.stripeCustomerId,
      hasStripeSubscription: !!company.stripeSubscriptionId,
      stripe: subscription
        ? {
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            // A subscription with no line items has no period end — guard the
            // `* 1000` so an empty `items.data` can't produce NaN and throw a
            // RangeError out of `new Date(NaN).toISOString()`.
            currentPeriodEnd:
              subscription.items.data[0]?.current_period_end != null
                ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
                : null,
            discounts: subscription.discounts,
          }
        : null,
    };
  }

  async listInvoices(companyId: string, query: ListInvoicesQueryDto) {
    const company = await this.requireCompany(companyId);
    const stripeCustomerId = this.requireStripeCustomerId(company);
    const stripe = this.billing.getStripeClient();
    const invoices = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: query.limit ?? 20,
      starting_after: query.startingAfter,
    });
    return {
      hasMore: invoices.has_more,
      items: invoices.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        created: new Date(inv.created * 1000).toISOString(),
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
      })),
    };
  }

  /**
   * The company's append-only billing audit trail (cap blocks, quantity changes,
   * signup lifecycle, dunning, staff overrides). Read cross-tenant via the
   * BYPASSRLS admin client, newest first, bounded.
   */
  async getAuditTrail(companyId: string, query: AuditTrailQueryDto) {
    await this.requireCompany(companyId);
    const take = query.limit ?? 50;
    const items = await this.adminPrisma.billingAuditLog.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, eventType: true, actorUserId: true, detail: true, createdAt: true },
    });
    return { items };
  }

  async refund(companyId: string, dto: RefundDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeCustomerId = this.requireStripeCustomerId(company);
    const stripe = this.billing.getStripeClient();
    const invoice = await this.requireOwnedInvoice(stripe, dto.invoiceId, stripeCustomerId);

    const { paymentIntentId, chargeId } = this.resolvePaymentReference(invoice);
    if (!paymentIntentId && !chargeId) {
      throw new BadRequestException({ code: 'INVOICE_NOT_PAID', message: 'This invoice has no associated payment to refund.' });
    }

    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        charge: paymentIntentId ? undefined : chargeId,
        amount: dto.amountCents,
        reason: dto.reason,
      },
      { idempotencyKey: this.idempotencyKey('refund', dto.invoiceId, context.adminUserId) },
    );

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_REFUND_ISSUED,
      entityType: 'stripe_invoice',
      entityId: dto.invoiceId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: dto.reason ?? null,
      afterValue: { refundId: refund.id, amountCents: refund.amount, status: refund.status },
    });

    return { refundId: refund.id, amountCents: refund.amount, status: refund.status };
  }

  async applyCoupon(companyId: string, dto: ApplyCouponDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeSubscriptionId = this.requireStripeSubscriptionId(company);
    const stripe = this.billing.getStripeClient();

    const before = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const subscription = await stripe.subscriptions.update(
      stripeSubscriptionId,
      { discounts: [{ coupon: dto.couponId }] },
      { idempotencyKey: this.idempotencyKey('apply_coupon', stripeSubscriptionId, context.adminUserId) },
    );

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_COUPON_APPLIED,
      entityType: 'stripe_subscription',
      entityId: stripeSubscriptionId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { discounts: before.discounts },
      afterValue: { couponId: dto.couponId, discounts: subscription.discounts },
    });

    return { subscriptionId: subscription.id, discounts: subscription.discounts };
  }

  /**
   * Creates an ad hoc line item and a "send invoice" (not auto-charged)
   * Stripe invoice, then finalizes it so it's payable/visible to the
   * customer immediately rather than sitting as an editable draft. Used for
   * one-off charges outside the normal subscription cycle (e.g. a custom
   * onboarding fee) — not for changing what a company's subscription itself
   * bills.
   */
  async createManualInvoice(companyId: string, dto: ManualInvoiceDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeCustomerId = this.requireStripeCustomerId(company);
    const stripe = this.billing.getStripeClient();
    const currency = (dto.currency ?? 'aud').toLowerCase();

    await stripe.invoiceItems.create(
      {
        customer: stripeCustomerId,
        amount: dto.amountCents,
        currency,
        description: dto.description,
      },
      { idempotencyKey: this.idempotencyKey('manual_invoice_item', stripeCustomerId, context.adminUserId) },
    );

    const draft = await stripe.invoices.create(
      {
        customer: stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: 7,
        // GST/Australian tax invoicing parity with the checkout flow (Phase 8):
        // an admin-issued invoice must carry GST too when Stripe Tax is enabled.
        ...(this.billing.isTaxEnabled() ? { automatic_tax: { enabled: true } } : {}),
      },
      { idempotencyKey: this.idempotencyKey('manual_invoice', stripeCustomerId, context.adminUserId) },
    );
    const invoice = await stripe.invoices.finalizeInvoice(
      draft.id,
      undefined,
      {
        // Idempotency parity with every other write in this service (Round 3 Medium):
        // keyed on the draft invoice id + the same per-minute bucket the helper uses,
        // so a double-click / bare retry can't double-finalize the same draft. The
        // key belongs in the 3rd (RequestOptions) arg, not the params body.
        idempotencyKey: this.idempotencyKey('finalize_invoice', draft.id, context.adminUserId),
      },
    );

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_MANUAL_INVOICE_CREATED,
      entityType: 'stripe_invoice',
      entityId: invoice.id,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { description: dto.description, amountCents: dto.amountCents, currency },
    });

    return { invoiceId: invoice.id, status: invoice.status, hostedInvoiceUrl: invoice.hosted_invoice_url };
  }

  async issueCreditNote(companyId: string, dto: CreditNoteDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeCustomerId = this.requireStripeCustomerId(company);
    const stripe = this.billing.getStripeClient();
    await this.requireOwnedInvoice(stripe, dto.invoiceId, stripeCustomerId);

    const creditNote = await stripe.creditNotes.create(
      {
        invoice: dto.invoiceId,
        amount: dto.amountCents,
        reason: dto.reason,
      },
      { idempotencyKey: this.idempotencyKey('credit_note', dto.invoiceId, context.adminUserId) },
    );

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_CREDIT_NOTE_ISSUED,
      entityType: 'stripe_invoice',
      entityId: dto.invoiceId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: dto.reason ?? null,
      afterValue: { creditNoteId: creditNote.id, amountCents: creditNote.amount },
    });

    return { creditNoteId: creditNote.id, amountCents: creditNote.amount, status: creditNote.status };
  }

  async retryPayment(companyId: string, dto: RetryPaymentDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeCustomerId = this.requireStripeCustomerId(company);
    const stripe = this.billing.getStripeClient();
    const before = await this.requireOwnedInvoice(stripe, dto.invoiceId, stripeCustomerId);

    const invoice = await stripe.invoices.pay(dto.invoiceId, undefined, {
      idempotencyKey: this.idempotencyKey('retry_payment', dto.invoiceId, context.adminUserId),
    });

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_PAYMENT_RETRIED,
      entityType: 'stripe_invoice',
      entityId: dto.invoiceId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { status: before.status },
      afterValue: { status: invoice.status },
    });

    return { invoiceId: invoice.id, status: invoice.status };
  }

  async cancelSubscription(companyId: string, dto: CancelSubscriptionDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeSubscriptionId = this.requireStripeSubscriptionId(company);
    const stripe = this.billing.getStripeClient();

    const before = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const idempotencyKey = this.idempotencyKey('cancel_subscription', stripeSubscriptionId, context.adminUserId);
    const subscription = dto.atPeriodEnd
      ? await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey })
      : await stripe.subscriptions.cancel(stripeSubscriptionId, undefined, { idempotencyKey });

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_SUBSCRIPTION_CANCELED,
      entityType: 'stripe_subscription',
      entityId: stripeSubscriptionId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { status: before.status, cancelAtPeriodEnd: before.cancel_at_period_end },
      afterValue: { atPeriodEnd: !!dto.atPeriodEnd, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end },
    });
    // Also record on the COMPANY's own billing ledger (billing_audit_logs), not
    // only the staff-side admin audit log, so the company's billing history
    // reflects a staff-initiated cancellation the same way a customer self-serve
    // cancel does. adminPrisma (fleetos_admin) has INSERT on billing_audit_logs
    // and bypasses RLS.
    await this.adminPrisma.billingAuditLog.create({
      data: {
        companyId,
        eventType: 'SUBSCRIPTION_CANCELED',
        actorAdminId: context.adminUserId,
        detail: { via: 'staff', atPeriodEnd: !!dto.atPeriodEnd },
      },
    });

    return { subscriptionId: subscription.id, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end };
  }

  /**
   * `cancel_for_cause` (Part 2): release a company from the 12-month minimum
   * term early. Staff-only, audited. Records when + why on the Company row and
   * lifts the contractual cancellation block (a subsequent cancel — customer- or
   * staff-initiated — is then permitted). This is the deliberate escape hatch so
   * a lock-in is never a position with zero technical ability to release a
   * customer (shutdown, dispute, regulator order). Not customer-facing.
   */
  async releaseFromContract(companyId: string, dto: ReleaseContractDto, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const releasedAt = new Date();
    await this.adminPrisma.company.update({
      where: { id: company.id },
      data: { contractReleasedAt: releasedAt, contractReleaseReason: dto.reason },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_CONTRACT_RELEASED,
      entityType: 'company',
      entityId: company.id,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { contractReleasedAt: releasedAt.toISOString(), reason: dto.reason },
    });
    // Also record on the COMPANY's own billing ledger (billing_audit_logs) so
    // the release shows in the company's billing history, not only the staff
    // admin audit log. adminPrisma (fleetos_admin) has INSERT + bypasses RLS.
    await this.adminPrisma.billingAuditLog.create({
      data: {
        companyId: company.id,
        eventType: 'MANUAL_OVERRIDE',
        actorAdminId: context.adminUserId,
        detail: { action: 'cancel_for_cause', reason: dto.reason },
      },
    });
    return { companyId: company.id, contractReleasedAt: releasedAt.toISOString() };
  }

  /**
   * Undoes a pending end-of-period cancellation. A subscription that has
   * already fully transitioned to `canceled` cannot be resumed by Stripe —
   * only a `cancel_at_period_end` flag can be unset before that happens —
   * so this refuses clearly rather than silently no-op-ing.
   */
  async reinstateSubscription(companyId: string, context: AdminActionContext) {
    const company = await this.requireCompany(companyId);
    const stripeSubscriptionId = this.requireStripeSubscriptionId(company);
    const stripe = this.billing.getStripeClient();

    const current = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    if (current.status === 'canceled') {
      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_CANCELED',
        message: 'This subscription has already ended and cannot be reinstated — start a new checkout instead.',
      });
    }
    if (!current.cancel_at_period_end) {
      throw new ConflictException({ code: 'SUBSCRIPTION_NOT_PENDING_CANCELLATION', message: 'This subscription is not scheduled to cancel.' });
    }

    const subscription = await stripe.subscriptions.update(
      stripeSubscriptionId,
      { cancel_at_period_end: false },
      { idempotencyKey: this.idempotencyKey('reinstate_subscription', stripeSubscriptionId, context.adminUserId) },
    );

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.BILLING_SUBSCRIPTION_REINSTATED,
      entityType: 'stripe_subscription',
      entityId: stripeSubscriptionId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { status: current.status, cancelAtPeriodEnd: current.cancel_at_period_end },
      afterValue: { status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end },
    });

    return { subscriptionId: subscription.id, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end };
  }
}
