import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createOrganisationUser, listOrganisationRoles } from '@/api/organisations';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';

interface CreateUserDialogProps {
  companyId: string;
  onClose: () => void;
  onCreated: () => void;
}

/** Support scenario: add a user on the customer's behalf (e.g. their only admin left). Omitting a password invites the user by email. */
export function CreateUserDialog({ companyId, onClose, onCreated }: CreateUserDialogProps) {
  const rolesQuery = useQuery({ queryKey: ['organisation-roles', companyId], queryFn: () => listOrganisationRoles(companyId) });
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');

  const mutation = useMutation({
    mutationFn: () => createOrganisationUser(companyId, { username, fullName, email: email || undefined, roleId }),
    onSuccess: () => {
      onCreated();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-(--radius-panel) border border-(--border-subtle) bg-(--surface-1) p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Add a user to this organisation</h2>
        <p className="mt-1 text-sm text-(--text-secondary)">Leaving no password sends them an email invite to set their own.</p>
        <div className="mt-4 space-y-3">
          <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <Input placeholder="Email (required to invite)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Select a role…</option>
            {rolesQuery.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        {mutation.isError && (
          <div className="mt-3">
            <ErrorState message={mutation.error instanceof ApiClientError ? mutation.error.message : 'Could not create the user.'} />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !username || !fullName || !roleId}>
            {mutation.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
