import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { listOrganisations } from '@/api/organisations';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState, EmptyState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';
import type { OrganisationSummary } from '@/api/types';

function statusBadge(org: OrganisationSummary) {
  if (org.archivedAt) return <Badge tone="neutral">Archived</Badge>;
  if (org.suspendedAt) return <Badge tone="danger">Suspended</Badge>;
  if (org.subscriptionStatus === 'TRIALING') return <Badge tone="accent">Trial</Badge>;
  if (org.subscriptionStatus === 'ACTIVE') return <Badge tone="success">Active</Badge>;
  if (org.subscriptionStatus === 'PAST_DUE') return <Badge tone="warning">Past due</Badge>;
  return <Badge tone="neutral">{org.subscriptionStatus}</Badge>;
}

export function OrganisationsListPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'suspended' | 'archived' | 'all'>('active');

  const query = useQuery({
    queryKey: ['organisations', page, search, status],
    queryFn: () => listOrganisations({ page, pageSize: 25, search: search || undefined, status }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Organisations</h1>
      </div>

      <div className="flex gap-3">
        <Input
          placeholder="Search by name…"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="w-40"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(1);
          }}
        >
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
      </div>

      <Card>
        {query.isLoading ? (
          <PageSpinner />
        ) : query.isError ? (
          <div className="p-5">
            <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load organisations.'} />
          </div>
        ) : query.data!.items.length === 0 ? (
          <EmptyState title="No organisations found" description="Try a different search or status filter." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Users</th>
                  <th className="px-5 py-3 font-medium">Trial ends</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {query.data!.items.map((org) => (
                  <tr key={org.id} className="border-b border-(--border-subtle) last:border-0 hover:bg-(--surface-2)">
                    <td className="px-5 py-3">
                      <Link to={`/organisations/${org.id}`} className="font-medium hover:text-accent-400">
                        {org.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3">{statusBadge(org)}</td>
                    <td className="px-5 py-3 text-(--text-secondary)">{org.userCount}</td>
                    <td className="px-5 py-3 text-(--text-secondary)">{org.trialEndsAt ? new Date(org.trialEndsAt).toLocaleDateString() : '—'}</td>
                    <td className="px-5 py-3 text-(--text-secondary)">{new Date(org.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={25} total={query.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
