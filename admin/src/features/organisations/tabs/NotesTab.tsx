import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addOrganisationNote, deleteOrganisationNote, listOrganisationNotes } from '@/api/support';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';

export function NotesTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const notesQuery = useQuery({ queryKey: ['organisation-notes', companyId], queryFn: () => listOrganisationNotes(companyId) });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['organisation-notes', companyId] });
  }

  const addMutation = useMutation({
    mutationFn: () => addOrganisationNote(companyId, draft),
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
  });
  const deleteMutation = useMutation({ mutationFn: (noteId: string) => deleteOrganisationNote(companyId, noteId), onSuccess: invalidate });

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-2">
          <Textarea placeholder="Internal note — never visible to the customer…" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button size="sm" disabled={!draft.trim() || addMutation.isPending} onClick={() => addMutation.mutate()}>
            Add note
          </Button>
        </CardBody>
      </Card>

      {notesQuery.isLoading ? (
        <PageSpinner />
      ) : notesQuery.data?.length ? (
        <div className="space-y-2">
          {notesQuery.data.map((note) => (
            <Card key={note.id}>
              <CardBody className="flex items-start justify-between gap-4">
                <div>
                  <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                  <p className="mt-1 text-xs text-(--text-tertiary)">
                    {note.adminUser?.fullName ?? 'Unknown admin'} · {new Date(note.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate(note.id)} disabled={deleteMutation.isPending}>
                  Delete
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="No notes yet" />
      )}
    </div>
  );
}
