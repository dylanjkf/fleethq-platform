import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as authApi from '@/api/auth';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

function SessionsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin-sessions'], queryFn: authApi.listSessions });
  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => authApi.revokeSession(sessionId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-sessions'] }),
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Active sessions</h2>
      </CardHeader>
      {query.isLoading ? (
        <PageSpinner />
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {query.data?.map((s) => (
              <tr key={s.id} className="border-b border-(--border-subtle) last:border-0">
                <td className="px-5 py-3">
                  <p className="font-medium">{s.deviceLabel ?? s.userAgent ?? 'Unknown device'}</p>
                  <p className="text-xs text-(--text-tertiary)">
                    {s.ipAddress} · last seen {new Date(s.lastSeenAt).toLocaleString()}
                  </p>
                </td>
                <td className="px-5 py-3">{s.isCurrent && <Badge tone="accent">This device</Badge>}</td>
                <td className="px-5 py-3 text-right">
                  {!s.isCurrent && (
                    <Button variant="ghost" size="sm" onClick={() => revokeMutation.mutate(s.id)} disabled={revokeMutation.isPending}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MfaCard() {
  const { admin, refreshMe } = useAuth();
  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setupMutation = useMutation({ mutationFn: authApi.setupMfa, onSuccess: setEnrolling });
  const enableMutation = useMutation({
    mutationFn: (c: string) => authApi.enableMfa(c),
    onSuccess: async (result) => {
      setBackupCodes(result.backupCodes);
      setEnrolling(null);
      setError(null);
      await refreshMe();
    },
    onError: (err) => setError(err instanceof ApiClientError ? err.message : 'Could not confirm that code.'),
  });
  const disableMutation = useMutation({
    mutationFn: (c: string) => authApi.disableMfa(c),
    onSuccess: async () => {
      setCode('');
      setError(null);
      await refreshMe();
    },
    onError: (err) => setError(err instanceof ApiClientError ? err.message : 'Could not disable MFA.'),
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Two-factor authentication</h2>
      </CardHeader>
      <CardBody className="space-y-3">
        {admin?.mfaEnabled ? (
          <>
            <p className="text-sm text-(--text-secondary)">MFA is enabled on your account.</p>
            <div className="flex max-w-xs gap-2">
              <Input placeholder="Current code" value={code} onChange={(e) => setCode(e.target.value)} />
              <Button variant="danger" size="sm" onClick={() => disableMutation.mutate(code)} disabled={!code || disableMutation.isPending}>
                Disable
              </Button>
            </div>
          </>
        ) : enrolling ? (
          <div className="space-y-2">
            <p className="text-sm text-(--text-secondary)">Scan this in your authenticator app, or enter the secret manually:</p>
            <code className="block break-all rounded bg-(--surface-2) px-2 py-1 text-xs">{enrolling.secret}</code>
            <div className="flex max-w-xs gap-2">
              <Input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
              <Button size="sm" onClick={() => enableMutation.mutate(code)} disabled={!code || enableMutation.isPending}>
                Confirm
              </Button>
            </div>
          </div>
        ) : backupCodes ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">MFA enabled. Save these one-time backup codes somewhere safe:</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
              {backupCodes.map((c) => (
                <li key={c} className="rounded bg-(--surface-2) px-2 py-1">
                  {c}
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" onClick={() => setBackupCodes(null)}>
              Done
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending}>
            Enable MFA
          </Button>
        )}
        {error && <ErrorState message={error} />}
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Security settings</h1>
      <MfaCard />
      <SessionsCard />
    </div>
  );
}
