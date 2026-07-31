import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as supportApi from '@/api/support';
import type { Announcement, AnnouncementSeverity } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ApiClientError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

function severityTone(severity: AnnouncementSeverity): 'accent' | 'warning' | 'danger' {
  if (severity === 'CRITICAL') return 'danger';
  if (severity === 'WARNING') return 'warning';
  return 'accent';
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<AnnouncementSeverity>('INFO');

  const mutation = useMutation({
    mutationFn: () => supportApi.createAnnouncement({ title, body, severity }),
    onSuccess: () => {
      setTitle('');
      setBody('');
      setSeverity('INFO');
      onCreated();
    },
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">New announcement</h2>
      </CardHeader>
      <CardBody className="space-y-2">
        <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea placeholder="Body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <Select value={severity} onChange={(e) => setSeverity(e.target.value as AnnouncementSeverity)} className="max-w-xs">
          <option value="INFO">Info</option>
          <option value="WARNING">Warning</option>
          <option value="CRITICAL">Critical</option>
        </Select>
        {mutation.isError && (
          <ErrorState message={mutation.error instanceof ApiClientError ? mutation.error.message : 'Could not create the announcement.'} />
        )}
        <Button size="sm" disabled={!title.trim() || !body.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          Publish
        </Button>
      </CardBody>
    </Card>
  );
}

function AnnouncementRow({ announcement, onChanged }: { announcement: Announcement; onChanged: () => void }) {
  const toggleMutation = useMutation({
    mutationFn: () => supportApi.updateAnnouncement(announcement.id, { active: !announcement.active }),
    onSuccess: onChanged,
  });
  const deleteMutation = useMutation({ mutationFn: () => supportApi.deleteAnnouncement(announcement.id), onSuccess: onChanged });

  return (
    <div className="flex items-start justify-between gap-4 border-b border-(--border-subtle) px-5 py-4 last:border-0">
      <div>
        <div className="flex items-center gap-2">
          <p className="font-medium">{announcement.title}</p>
          <Badge tone={severityTone(announcement.severity)}>{announcement.severity}</Badge>
          {announcement.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
        </div>
        <p className="mt-1 text-sm text-(--text-secondary)">{announcement.body}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={() => toggleMutation.mutate()} disabled={toggleMutation.isPending}>
          {announcement.active ? 'Deactivate' : 'Activate'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export function AnnouncementsPage() {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const query = useQuery({ queryKey: ['announcements'], queryFn: supportApi.listAnnouncements });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['announcements'] });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Announcements</h1>

      {hasPermission('support:manage') && <CreateForm onCreated={invalidate} />}

      <Card>
        {query.isLoading ? (
          <PageSpinner />
        ) : query.isError ? (
          <div className="p-5">
            <ErrorState message={query.error instanceof ApiClientError ? query.error.message : 'Could not load announcements.'} />
          </div>
        ) : query.data?.length ? (
          query.data.map((a) => <AnnouncementRow key={a.id} announcement={a} onChanged={invalidate} />)
        ) : (
          <EmptyState title="No announcements yet" />
        )}
      </Card>
    </div>
  );
}
