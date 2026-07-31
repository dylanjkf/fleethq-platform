import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as flagsApi from '@/api/feature-flags';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: () => flagsApi.createFeatureFlag({ key, name, description, globalEnabled: true }),
    onSuccess: () => {
      setKey('');
      setName('');
      setDescription('');
      onCreated();
    },
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">New flag</h2>
      </CardHeader>
      <CardBody className="space-y-2">
        <Input placeholder="key (e.g. operational_recommendations)" value={key} onChange={(e) => setKey(e.target.value)} />
        <Input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea placeholder="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        {mutation.isError && (
          <ErrorState message={mutation.error instanceof ApiClientError ? mutation.error.message : 'Could not create the flag.'} />
        )}
        <Button size="sm" disabled={!key.trim() || !name.trim() || !description.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          Create (enabled by default)
        </Button>
      </CardBody>
    </Card>
  );
}

export function FeatureFlagsPage() {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const query = useQuery({ queryKey: ['feature-flags'], queryFn: flagsApi.listFeatureFlags });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['feature-flags'] });
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, globalEnabled }: { id: string; globalEnabled: boolean }) => flagsApi.updateFeatureFlag(id, { globalEnabled }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({ mutationFn: (id: string) => flagsApi.deleteFeatureFlag(id), onSuccess: invalidate });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Feature Flags</h1>

      {hasPermission('feature_flags:manage') && <CreateForm onCreated={invalidate} />}

      <Card>
        {query.isLoading ? (
          <PageSpinner />
        ) : query.isError ? (
          <div className="p-5">
            <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load feature flags.'} />
          </div>
        ) : query.data?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
                <th className="px-5 py-3 font-medium">Flag</th>
                <th className="px-5 py-3 font-medium">Global default</th>
                <th className="px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((flag) => (
                <tr key={flag.id} className="border-b border-(--border-subtle) last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium">{flag.name}</p>
                    <p className="text-xs text-(--text-tertiary)">{flag.key}</p>
                    <p className="mt-0.5 text-xs text-(--text-secondary)">{flag.description}</p>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={flag.globalEnabled ? 'success' : 'neutral'}>{flag.globalEnabled ? 'Enabled' : 'Disabled'}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleMutation.mutate({ id: flag.id, globalEnabled: !flag.globalEnabled })}
                        disabled={toggleMutation.isPending}
                      >
                        {flag.globalEnabled ? 'Disable globally' : 'Enable globally'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate(flag.id)} disabled={deleteMutation.isPending}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No feature flags yet" description="Create one above — a gated route treats a missing flag as enabled, so this is always safe." />
        )}
      </Card>
    </div>
  );
}
