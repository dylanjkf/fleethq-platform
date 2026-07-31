import { useQuery } from '@tanstack/react-query';
import { getSystemHealth } from '@/api/system';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function SystemHealthPage() {
  const query = useQuery({ queryKey: ['system-health'], queryFn: getSystemHealth, refetchInterval: 30_000 });

  if (query.isLoading) return <PageSpinner />;
  if (query.isError || !query.data) {
    return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load system health.'} />;
  }
  const health = query.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">System Health</h1>
        <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Database connectivity</h2>
        </CardHeader>
        <CardBody className="flex gap-6">
          <div>
            <p className="text-xs text-(--text-tertiary)">Customer API (fleetos_app)</p>
            <Badge tone={health.database.customerApiConnected ? 'success' : 'danger'}>
              {health.database.customerApiConnected ? 'Connected' : 'Unreachable'}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-(--text-tertiary)">Admin platform (fleetos_admin)</p>
            <Badge tone={health.database.adminPlatformConnected ? 'success' : 'danger'}>
              {health.database.adminPlatformConnected ? 'Connected' : 'Unreachable'}
            </Badge>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Process</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-(--text-tertiary)">Uptime</p>
            <p className="text-sm font-medium">{formatUptime(health.process.uptimeSeconds)}</p>
          </div>
          <div>
            <p className="text-xs text-(--text-tertiary)">Node version</p>
            <p className="text-sm font-medium">{health.process.nodeVersion}</p>
          </div>
          <div>
            <p className="text-xs text-(--text-tertiary)">Environment</p>
            <p className="text-sm font-medium">{health.process.nodeEnv}</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Version</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-(--text-tertiary)">API version</p>
            <p className="text-sm font-medium">{health.version.apiVersion}</p>
          </div>
          <div>
            <p className="text-xs text-(--text-tertiary)">Deployed commit</p>
            <p className="text-sm font-medium">{health.version.deployedCommit ?? 'Not reported by this deployment'}</p>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-(--text-tertiary)">Checked at {new Date(health.checkedAt).toLocaleString()}</p>
    </div>
  );
}
