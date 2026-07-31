import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearFeatureFlagOverride, listOrganisationFeatureFlags, setFeatureFlagOverride } from '@/api/feature-flags';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';

export function FeatureFlagsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['organisation-feature-flags', companyId], queryFn: () => listOrganisationFeatureFlags(companyId) });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['organisation-feature-flags', companyId] });
  }

  const setMutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => setFeatureFlagOverride(companyId, key, enabled),
    onSuccess: invalidate,
  });
  const clearMutation = useMutation({ mutationFn: (key: string) => clearFeatureFlagOverride(companyId, key), onSuccess: invalidate });

  if (query.isLoading) return <PageSpinner />;
  if (!query.data?.length) return <EmptyState title="No feature flags exist yet" description="Create one from the Feature Flags page." />;

  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
            <th className="px-5 py-3 font-medium">Flag</th>
            <th className="px-5 py-3 font-medium">Global default</th>
            <th className="px-5 py-3 font-medium">Override</th>
            <th className="px-5 py-3 font-medium">Effective</th>
            <th className="px-5 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {query.data.map((flag) => (
            <tr key={flag.id} className="border-b border-(--border-subtle) last:border-0">
              <td className="px-5 py-3">
                <p className="font-medium">{flag.name}</p>
                <p className="text-xs text-(--text-tertiary)">{flag.key}</p>
              </td>
              <td className="px-5 py-3">
                <Badge tone={flag.globalEnabled ? 'success' : 'neutral'}>{flag.globalEnabled ? 'Enabled' : 'Disabled'}</Badge>
              </td>
              <td className="px-5 py-3">
                {flag.override === null ? <span className="text-(--text-tertiary)">None</span> : <Badge tone={flag.override ? 'success' : 'danger'}>{flag.override ? 'Enabled' : 'Disabled'}</Badge>}
              </td>
              <td className="px-5 py-3">
                <Badge tone={flag.effective ? 'success' : 'neutral'}>{flag.effective ? 'Enabled' : 'Disabled'}</Badge>
              </td>
              <td className="px-5 py-3 text-right">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setMutation.mutate({ key: flag.key, enabled: true })}>
                    Enable
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setMutation.mutate({ key: flag.key, enabled: false })}>
                    Disable
                  </Button>
                  {flag.override !== null && (
                    <Button variant="ghost" size="sm" onClick={() => clearMutation.mutate(flag.key)}>
                      Clear
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
