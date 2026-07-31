import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import * as customerUsersApi from '@/api/customer-users';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

export function CustomerUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = useQuery({ queryKey: ['customer-user', userId], queryFn: () => customerUsersApi.getCustomerUser(userId!), enabled: !!userId });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['customer-user', userId] });
  }

  const disableMutation = useMutation({ mutationFn: () => customerUsersApi.disableCustomerUser(userId!), onSuccess: invalidate });
  const reactivateMutation = useMutation({ mutationFn: () => customerUsersApi.reactivateCustomerUser(userId!), onSuccess: invalidate });
  const unlockMutation = useMutation({ mutationFn: () => customerUsersApi.unlockCustomerUser(userId!), onSuccess: invalidate });
  const resetMfaMutation = useMutation({ mutationFn: () => customerUsersApi.resetCustomerUserMfa(userId!), onSuccess: invalidate });
  const passwordResetMutation = useMutation({
    mutationFn: () => customerUsersApi.sendCustomerPasswordReset(userId!),
    onSuccess: (result) => setFeedback(result.emailOnFile ? 'Password reset email sent.' : 'No email on file — nothing was sent.'),
  });
  const resendVerificationMutation = useMutation({
    mutationFn: () => customerUsersApi.resendCustomerVerification(userId!),
    onSuccess: (result) => setFeedback(result.emailOnFile ? 'Verification email sent.' : 'No unverified email on file — nothing was sent.'),
  });

  if (query.isLoading) return <PageSpinner />;
  if (query.isError || !query.data) {
    return <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load this user.'} />;
  }
  const user = query.data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{user.fullName}</h1>
        <p className="text-sm text-(--text-secondary)">{user.username}</p>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          {user.accountDisabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="success">Active</Badge>}
          {user.locked && <Badge tone="warning">Locked</Badge>}
          {user.mfaEnabled && <Badge tone="accent">MFA enabled</Badge>}
          {user.email && !user.emailVerifiedAt && <Badge tone="warning">Email unverified</Badge>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Actions</h2>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-2">
          {user.accountDisabled ? (
            <Button variant="secondary" size="sm" onClick={() => reactivateMutation.mutate()} disabled={reactivateMutation.isPending}>
              Reactivate
            </Button>
          ) : (
            <Button variant="danger" size="sm" onClick={() => disableMutation.mutate()} disabled={disableMutation.isPending}>
              Disable
            </Button>
          )}
          {user.locked && (
            <Button variant="secondary" size="sm" onClick={() => unlockMutation.mutate()} disabled={unlockMutation.isPending}>
              Unlock
            </Button>
          )}
          {user.mfaEnabled && (
            <Button variant="secondary" size="sm" onClick={() => resetMfaMutation.mutate()} disabled={resetMfaMutation.isPending}>
              Reset MFA
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => passwordResetMutation.mutate()} disabled={passwordResetMutation.isPending}>
            Send password reset
          </Button>
          <Button variant="secondary" size="sm" onClick={() => resendVerificationMutation.mutate()} disabled={resendVerificationMutation.isPending}>
            Resend verification email
          </Button>
        </CardBody>
        {feedback && <p className="px-5 pb-4 text-sm text-(--text-secondary)">{feedback}</p>}
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Organisations</h2>
        </CardHeader>
        {user.organisations.length ? (
          <table className="w-full text-sm">
            <tbody>
              {user.organisations.map((org) => (
                <tr key={org.companyId} className="border-b border-(--border-subtle) last:border-0">
                  <td className="px-5 py-3">
                    <Link to={`/organisations/${org.companyId}`} className="font-medium hover:text-accent-400">
                      {org.companyName}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-(--text-secondary)">{org.role.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-4 text-sm text-(--text-tertiary)">No active memberships.</p>
        )}
      </Card>
    </div>
  );
}
