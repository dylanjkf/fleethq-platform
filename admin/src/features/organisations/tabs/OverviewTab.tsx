import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  archiveOrganisation,
  impersonateUser,
  restoreOrganisation,
  suspendOrganisation,
  unarchiveOrganisation,
  updateTrial,
} from '@/api/organisations';
import type { OrganisationDetail } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { CreateUserDialog } from './CreateUserDialog';

export function OverviewTab({ org }: { org: OrganisationDetail }) {
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<'suspend' | 'archive' | null>(null);
  const [trialDraft, setTrialDraft] = useState(org.trialEndsAt ? org.trialEndsAt.slice(0, 10) : '');
  const [impersonation, setImpersonation] = useState<{ accessToken: string; expiresIn: string } | null>(null);
  const [createUserOpen, setCreateUserOpen] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['organisation', org.id] });
  }

  const suspendMutation = useMutation({ mutationFn: (reason: string) => suspendOrganisation(org.id, reason), onSuccess: invalidate });
  const restoreMutation = useMutation({ mutationFn: () => restoreOrganisation(org.id), onSuccess: invalidate });
  const archiveMutation = useMutation({ mutationFn: () => archiveOrganisation(org.id), onSuccess: invalidate });
  const unarchiveMutation = useMutation({ mutationFn: () => unarchiveOrganisation(org.id), onSuccess: invalidate });
  const trialMutation = useMutation({
    mutationFn: (trialEndsAt: string | null) => updateTrial(org.id, trialEndsAt),
    onSuccess: invalidate,
  });
  const impersonateMutation = useMutation({
    mutationFn: (userId: string) => impersonateUser(org.id, userId),
    onSuccess: (result) => setImpersonation(result),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          {!org.archivedAt && !org.suspendedAt && (
            <Button variant="danger" size="sm" onClick={() => setConfirmAction('suspend')}>
              Suspend
            </Button>
          )}
          {org.suspendedAt && (
            <Button variant="secondary" size="sm" onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending}>
              Restore
            </Button>
          )}
          {!org.archivedAt && (
            <Button variant="secondary" size="sm" onClick={() => setConfirmAction('archive')}>
              Archive
            </Button>
          )}
          {org.archivedAt && (
            <Button variant="secondary" size="sm" onClick={() => unarchiveMutation.mutate()} disabled={unarchiveMutation.isPending}>
              Unarchive
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setCreateUserOpen(true)}>
            Add user
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-(--text-tertiary)">Trial end date</p>
          <div className="flex gap-2">
            <Input type="date" className="max-w-xs" value={trialDraft} onChange={(e) => setTrialDraft(e.target.value)} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => trialMutation.mutate(trialDraft ? new Date(trialDraft).toISOString() : null)}
              disabled={trialMutation.isPending}
            >
              Save
            </Button>
            {org.trialEndsAt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTrialDraft('');
                  trialMutation.mutate(null);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <div className="border-b border-(--border-subtle) px-5 py-4">
          <h2 className="text-sm font-semibold">Users ({org.users.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--border-subtle) text-left text-xs uppercase tracking-wide text-(--text-tertiary)">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {org.users.map((u) => (
              <tr key={u.membershipId} className="border-b border-(--border-subtle) last:border-0">
                <td className="px-5 py-3">
                  <Link to={`/customer-users/${u.userId}`} className="font-medium hover:text-accent-400">
                    {u.fullName}
                  </Link>
                  <p className="text-xs text-(--text-tertiary)">{u.username}</p>
                </td>
                <td className="px-5 py-3 text-(--text-secondary)">{u.role.name}</td>
                <td className="px-5 py-3">
                  {u.accountDisabled && <Badge tone="danger">Disabled</Badge>}
                  {u.locked && <Badge tone="warning">Locked</Badge>}
                  {!u.accountDisabled && !u.locked && <Badge tone="success">Active</Badge>}
                </td>
                <td className="px-5 py-3 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => impersonateMutation.mutate(u.userId)}
                    disabled={impersonateMutation.isPending || !!org.suspendedAt || !!org.archivedAt}
                  >
                    Impersonate
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {confirmAction === 'suspend' && (
        <ConfirmDialog
          title="Suspend organisation"
          description="Blocks all login/access immediately."
          confirmLabel="Suspend"
          danger
          requireReason
          onConfirm={async (reason) => {
            await suspendMutation.mutateAsync(reason ?? '');
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'archive' && (
        <ConfirmDialog
          title="Archive organisation"
          description="Soft-deletes this organisation. It can be unarchived later."
          confirmLabel="Archive"
          danger
          onConfirm={async () => {
            await archiveMutation.mutateAsync();
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {impersonation && (
        <ConfirmDialog
          title="Impersonation session started"
          description={`Expires in ${impersonation.expiresIn}. Copy this token and use it as the customer app's session token.`}
          confirmLabel="Copy token"
          onConfirm={() => {
            void navigator.clipboard.writeText(impersonation.accessToken);
            setImpersonation(null);
          }}
          onCancel={() => setImpersonation(null)}
        />
      )}
      {createUserOpen && <CreateUserDialog companyId={org.id} onClose={() => setCreateUserOpen(false)} onCreated={invalidate} />}
    </div>
  );
}
