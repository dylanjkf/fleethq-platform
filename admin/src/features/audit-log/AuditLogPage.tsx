import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchAuditLog } from '@/api/audit-log';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['audit-log', action, page],
    queryFn: () => searchAuditLog({ action: action || undefined, page, pageSize: 50 }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit Log</h1>
      <p className="text-sm text-(--text-secondary)">Every administrative action FleetHQ staff has taken on this platform.</p>

      <Input
        placeholder="Filter by exact action key (e.g. organisations.suspended)…"
        className="max-w-md"
        value={action}
        onChange={(e) => {
          setAction(e.target.value);
          setPage(1);
        }}
      />

      <Card>
        {query.isLoading ? (
          <PageSpinner />
        ) : query.isError ? (
          <div className="p-5">
            <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load the audit log.'} />
          </div>
        ) : query.data!.items.length === 0 ? (
          <EmptyState title="No matching entries" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Admin</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                  <th className="px-5 py-3 font-medium">Entity</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {query.data!.items.map((entry) => (
                  <tr key={entry.id} className="border-b border-(--border-subtle) last:border-0">
                    <td className="px-5 py-3 whitespace-nowrap text-(--text-secondary)">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-3">{entry.adminUser?.fullName ?? '—'}</td>
                    <td className="px-5 py-3 font-mono text-xs">{entry.action}</td>
                    <td className="px-5 py-3 text-(--text-secondary)">
                      {entry.entityType}
                      {entry.entityId ? `:${entry.entityId.slice(0, 8)}…` : ''}
                    </td>
                    <td className="px-5 py-3 text-(--text-secondary)">{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={50} total={query.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
