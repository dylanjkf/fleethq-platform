import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as billingApi from '@/api/billing';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

export function BillingTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['billing-status', companyId], queryFn: () => billingApi.getBillingStatus(companyId) });
  const invoicesQuery = useQuery({ queryKey: ['billing-invoices', companyId], queryFn: () => billingApi.listInvoices(companyId, 20) });

  const [refundInvoiceId, setRefundInvoiceId] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [couponId, setCouponId] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [creditInvoiceId, setCreditInvoiceId] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [retryInvoiceId, setRetryInvoiceId] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['billing-status', companyId] });
    void queryClient.invalidateQueries({ queryKey: ['billing-invoices', companyId] });
  }

  async function run(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
      invalidate();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'That billing action failed.');
    }
  }

  const cancelMutation = useMutation({ mutationFn: (atPeriodEnd: boolean) => billingApi.cancelSubscription(companyId, atPeriodEnd), onSuccess: invalidate });
  const reinstateMutation = useMutation({ mutationFn: () => billingApi.reinstateSubscription(companyId), onSuccess: invalidate });

  if (statusQuery.isLoading) return <PageSpinner />;
  if (statusQuery.isError) {
    return <ErrorState message={statusQuery.error instanceof ApiClientError ? statusQuery.error.message : 'Could not load billing status.'} />;
  }
  const status = statusQuery.data!;

  if (!status.billingConfigured) {
    return <ErrorState message="Billing is not configured on this deployment." />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Status</h2>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p>
            Subscription: <Badge tone="accent">{status.subscriptionStatus}</Badge>
          </p>
          {status.stripe && (
            <>
              <p>Stripe status: {status.stripe.status}</p>
              <p>Current period ends: {new Date(status.stripe.currentPeriodEnd).toLocaleString()}</p>
              <p>Cancel at period end: {status.stripe.cancelAtPeriodEnd ? 'Yes' : 'No'}</p>
            </>
          )}
          {!status.hasStripeCustomer && <p className="text-(--text-tertiary)">No Stripe customer yet.</p>}
          {status.hasStripeSubscription && (
            <div className="flex gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => cancelMutation.mutate(true)} disabled={cancelMutation.isPending}>
                Cancel at period end
              </Button>
              <Button variant="danger" size="sm" onClick={() => cancelMutation.mutate(false)} disabled={cancelMutation.isPending}>
                Cancel immediately
              </Button>
              {status.stripe?.cancelAtPeriodEnd && (
                <Button variant="secondary" size="sm" onClick={() => reinstateMutation.mutate()} disabled={reinstateMutation.isPending}>
                  Reinstate
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {actionError && <ErrorState message={actionError} />}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Invoices</h2>
        </CardHeader>
        {invoicesQuery.data?.items.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
                <th className="px-5 py-2 font-medium">Number</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Amount due</th>
                <th className="px-5 py-2 font-medium">Created</th>
                <th className="px-5 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {invoicesQuery.data.items.map((inv) => (
                <tr key={inv.id} className="border-b border-(--border-subtle) last:border-0">
                  <td className="px-5 py-2">{inv.number ?? inv.id}</td>
                  <td className="px-5 py-2">{inv.status}</td>
                  <td className="px-5 py-2">
                    {(inv.amountDue / 100).toFixed(2)} {inv.currency.toUpperCase()}
                  </td>
                  <td className="px-5 py-2 text-(--text-secondary)">{new Date(inv.created).toLocaleDateString()}</td>
                  <td className="px-5 py-2 text-right">
                    {inv.hostedInvoiceUrl && (
                      <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-accent-400 hover:underline">
                        View
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-4 text-sm text-(--text-tertiary)">No invoices.</p>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Refund</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <Input placeholder="Invoice ID" value={refundInvoiceId} onChange={(e) => setRefundInvoiceId(e.target.value)} />
            <Input placeholder="Amount in cents (blank = full)" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
            <Button
              size="sm"
              disabled={!refundInvoiceId}
              onClick={() =>
                run(async () => {
                  await billingApi.refundInvoice(companyId, refundInvoiceId, refundAmount ? Number(refundAmount) : undefined);
                  setRefundInvoiceId('');
                  setRefundAmount('');
                })
              }
            >
              Issue refund
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Apply coupon</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <Input placeholder="Stripe coupon ID" value={couponId} onChange={(e) => setCouponId(e.target.value)} />
            <Button
              size="sm"
              disabled={!couponId}
              onClick={() =>
                run(async () => {
                  await billingApi.applyCoupon(companyId, couponId);
                  setCouponId('');
                })
              }
            >
              Apply
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Manual invoice</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <Input placeholder="Description" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} />
            <Input placeholder="Amount in cents" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} />
            <Button
              size="sm"
              disabled={!manualDesc || !manualAmount}
              onClick={() =>
                run(async () => {
                  await billingApi.createManualInvoice(companyId, manualDesc, Number(manualAmount));
                  setManualDesc('');
                  setManualAmount('');
                })
              }
            >
              Create invoice
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Credit note</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <Input placeholder="Invoice ID" value={creditInvoiceId} onChange={(e) => setCreditInvoiceId(e.target.value)} />
            <Input placeholder="Amount in cents" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />
            <Button
              size="sm"
              disabled={!creditInvoiceId || !creditAmount}
              onClick={() =>
                run(async () => {
                  await billingApi.issueCreditNote(companyId, creditInvoiceId, Number(creditAmount));
                  setCreditInvoiceId('');
                  setCreditAmount('');
                })
              }
            >
              Issue credit note
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Retry payment</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <Input placeholder="Invoice ID" value={retryInvoiceId} onChange={(e) => setRetryInvoiceId(e.target.value)} />
            <Button
              size="sm"
              disabled={!retryInvoiceId}
              onClick={() =>
                run(async () => {
                  await billingApi.retryPayment(companyId, retryInvoiceId);
                  setRetryInvoiceId('');
                })
              }
            >
              Retry
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
