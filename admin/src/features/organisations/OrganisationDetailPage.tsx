import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { getOrganisation } from '@/api/organisations';
import { Badge } from '@/components/ui/Badge';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { OverviewTab } from './tabs/OverviewTab';
import { BillingTab } from './tabs/BillingTab';
import { NotesTab } from './tabs/NotesTab';
import { FeatureFlagsTab } from './tabs/FeatureFlagsTab';

type TabKey = 'overview' | 'billing' | 'notes' | 'feature-flags';

export function OrganisationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState<TabKey>('overview');

  const query = useQuery({ queryKey: ['organisation', id], queryFn: () => getOrganisation(id!), enabled: !!id });

  if (query.isLoading) return <PageSpinner />;
  if (query.isError || !query.data) {
    return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load this organisation.'} />;
  }
  const org = query.data;

  const tabs: { key: TabKey; label: string; visible: boolean }[] = [
    { key: 'overview', label: 'Overview', visible: true },
    { key: 'billing', label: 'Billing', visible: hasPermission('billing:view') },
    { key: 'notes', label: 'Notes', visible: hasPermission('support:view') },
    { key: 'feature-flags', label: 'Feature Flags', visible: hasPermission('feature_flags:view') },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{org.name}</h1>
        <div className="mt-1 flex items-center gap-2 text-sm text-(--text-secondary)">
          <span>{org.jurisdiction}</span>
          <Badge tone="neutral">{org.counts.assets} assets</Badge>
          <Badge tone="neutral">{org.counts.operators} operators</Badge>
        </div>
      </div>

      <div className="flex gap-1 border-b border-(--border-subtle)">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.key ? 'border-accent-500 text-accent-400' : 'border-transparent text-(--text-secondary) hover:text-(--text-primary)'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab === 'overview' && <OverviewTab org={org} />}
      {tab === 'billing' && hasPermission('billing:view') && <BillingTab companyId={org.id} />}
      {tab === 'notes' && hasPermission('support:view') && <NotesTab companyId={org.id} />}
      {tab === 'feature-flags' && hasPermission('feature_flags:view') && <FeatureFlagsTab companyId={org.id} />}
    </div>
  );
}
