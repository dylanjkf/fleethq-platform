import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import * as fleetApi from '@/api/fleet';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

type TabKey = 'assets' | 'operators' | 'integrations';

function AssetsTable({ search, page, onPageChange }: { search: string; page: number; onPageChange: (p: number) => void }) {
  const query = useQuery({ queryKey: ['fleet-assets', search, page], queryFn: () => fleetApi.searchAssets({ search: search || undefined, page, pageSize: 25 }) });
  if (query.isLoading) return <PageSpinner />;
  if (query.isError) return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Search failed.'} />;
  if (!query.data!.items.length) return <EmptyState title="No matching assets" />;
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
            <th className="px-5 py-3 font-medium">Name</th>
            <th className="px-5 py-3 font-medium">Make/model</th>
            <th className="px-5 py-3 font-medium">VIN</th>
            <th className="px-5 py-3 font-medium">Registration</th>
            <th className="px-5 py-3 font-medium">Organisation</th>
          </tr>
        </thead>
        <tbody>
          {query.data!.items.map((a) => (
            <tr key={a.id} className="border-b border-(--border-subtle) last:border-0">
              <td className="px-5 py-3 font-medium">{a.name}</td>
              <td className="px-5 py-3 text-(--text-secondary)">{[a.make, a.model, a.year].filter(Boolean).join(' ') || '—'}</td>
              <td className="px-5 py-3 text-(--text-secondary)">{a.vin ?? '—'}</td>
              <td className="px-5 py-3 text-(--text-secondary)">{a.registration ?? '—'}</td>
              <td className="px-5 py-3">
                <Link to={`/organisations/${a.company.id}`} className="text-accent-400 hover:underline">
                  {a.company.name}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} pageSize={25} total={query.data!.total} onPageChange={onPageChange} />
    </>
  );
}

function OperatorsTable({ search, page, onPageChange }: { search: string; page: number; onPageChange: (p: number) => void }) {
  const query = useQuery({ queryKey: ['fleet-operators', search, page], queryFn: () => fleetApi.searchOperators({ search: search || undefined, page, pageSize: 25 }) });
  if (query.isLoading) return <PageSpinner />;
  if (query.isError) return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Search failed.'} />;
  if (!query.data!.items.length) return <EmptyState title="No matching operators" />;
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
            <th className="px-5 py-3 font-medium">Name</th>
            <th className="px-5 py-3 font-medium">Email</th>
            <th className="px-5 py-3 font-medium">Organisation</th>
          </tr>
        </thead>
        <tbody>
          {query.data!.items.map((o) => (
            <tr key={o.id} className="border-b border-(--border-subtle) last:border-0">
              <td className="px-5 py-3 font-medium">{o.fullName}</td>
              <td className="px-5 py-3 text-(--text-secondary)">{o.email ?? '—'}</td>
              <td className="px-5 py-3">
                <Link to={`/organisations/${o.company.id}`} className="text-accent-400 hover:underline">
                  {o.company.name}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} pageSize={25} total={query.data!.total} onPageChange={onPageChange} />
    </>
  );
}

function IntegrationsTable({ search, page, onPageChange }: { search: string; page: number; onPageChange: (p: number) => void }) {
  const query = useQuery({
    queryKey: ['fleet-integrations', search, page],
    queryFn: () => fleetApi.searchIntegrations({ search: search || undefined, page, pageSize: 25 }),
  });
  if (query.isLoading) return <PageSpinner />;
  if (query.isError) return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Search failed.'} />;
  if (!query.data!.items.length) return <EmptyState title="No matching integrations" />;
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
            <th className="px-5 py-3 font-medium">Name</th>
            <th className="px-5 py-3 font-medium">Type</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 font-medium">Last sync</th>
            <th className="px-5 py-3 font-medium">Organisation</th>
          </tr>
        </thead>
        <tbody>
          {query.data!.items.map((i) => (
            <tr key={i.id} className="border-b border-(--border-subtle) last:border-0">
              <td className="px-5 py-3 font-medium">{i.name}</td>
              <td className="px-5 py-3 text-(--text-secondary)">
                {i.connectorType} · {i.direction}
              </td>
              <td className="px-5 py-3">
                <Badge tone={i.isEnabled ? 'success' : 'neutral'}>{i.isEnabled ? 'Enabled' : 'Disabled'}</Badge>
              </td>
              <td className="px-5 py-3 text-(--text-secondary)">{i.lastSyncAt ? new Date(i.lastSyncAt).toLocaleString() : 'Never'}</td>
              <td className="px-5 py-3">
                <Link to={`/organisations/${i.company.id}`} className="text-accent-400 hover:underline">
                  {i.company.name}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} pageSize={25} total={query.data!.total} onPageChange={onPageChange} />
    </>
  );
}

export function FleetPage() {
  const [tab, setTab] = useState<TabKey>('assets');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  function switchTab(next: TabKey) {
    setTab(next);
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Fleet</h1>
      <p className="text-sm text-(--text-secondary)">Cross-tenant search — who owns this asset, operator, or integration.</p>

      <div className="flex gap-1 border-b border-(--border-subtle)">
        {(['assets', 'operators', 'integrations'] as const).map((key) => (
          <button
            key={key}
            onClick={() => switchTab(key)}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize transition-colors ${
              tab === key ? 'border-accent-500 text-accent-400' : 'border-transparent text-(--text-secondary) hover:text-(--text-primary)'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      <Input
        placeholder={tab === 'assets' ? 'Search by name, VIN, registration…' : tab === 'operators' ? 'Search by name or email…' : 'Search by name…'}
        className="max-w-sm"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />

      <Card>
        {tab === 'assets' && <AssetsTable search={search} page={page} onPageChange={setPage} />}
        {tab === 'operators' && <OperatorsTable search={search} page={page} onPageChange={setPage} />}
        {tab === 'integrations' && <IntegrationsTable search={search} page={page} onPageChange={setPage} />}
      </Card>
    </div>
  );
}
