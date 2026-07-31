import { apiClient } from './client';
import type { BillingStatus, StripeInvoice } from './types';

export async function getBillingStatus(companyId: string): Promise<BillingStatus> {
  const { data } = await apiClient.get<BillingStatus>(`/v1/admin/organisations/${companyId}/billing`);
  return data;
}

export async function listInvoices(companyId: string, limit = 20): Promise<{ hasMore: boolean; items: StripeInvoice[] }> {
  const { data } = await apiClient.get<{ hasMore: boolean; items: StripeInvoice[] }>(`/v1/admin/organisations/${companyId}/billing/invoices`, {
    params: { limit },
  });
  return data;
}

export async function refundInvoice(companyId: string, invoiceId: string, amountCents?: number, reason?: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/refund`, { invoiceId, amountCents, reason });
}

export async function applyCoupon(companyId: string, couponId: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/coupon`, { couponId });
}

export async function createManualInvoice(companyId: string, description: string, amountCents: number, currency?: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/manual-invoice`, { description, amountCents, currency });
}

export async function issueCreditNote(companyId: string, invoiceId: string, amountCents: number, reason?: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/credit-note`, { invoiceId, amountCents, reason });
}

export async function retryPayment(companyId: string, invoiceId: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/retry-payment`, { invoiceId });
}

export async function cancelSubscription(companyId: string, atPeriodEnd: boolean): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/cancel`, { atPeriodEnd });
}

export async function reinstateSubscription(companyId: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${companyId}/billing/reinstate`);
}
