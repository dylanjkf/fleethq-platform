import { apiClient } from './client';
import type { Announcement, AnnouncementSeverity, OrganisationNote } from './types';

export async function listAnnouncements(): Promise<Announcement[]> {
  const { data } = await apiClient.get<Announcement[]>('/v1/admin/announcements');
  return data;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  severity?: AnnouncementSeverity;
  startsAt?: string;
  endsAt?: string;
}

export async function createAnnouncement(input: CreateAnnouncementInput): Promise<Announcement> {
  const { data } = await apiClient.post<Announcement>('/v1/admin/announcements', input);
  return data;
}

export async function updateAnnouncement(id: string, input: Partial<CreateAnnouncementInput & { active: boolean }>): Promise<Announcement> {
  const { data } = await apiClient.patch<Announcement>(`/v1/admin/announcements/${id}`, input);
  return data;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await apiClient.delete(`/v1/admin/announcements/${id}`);
}

export async function listOrganisationNotes(companyId: string): Promise<OrganisationNote[]> {
  const { data } = await apiClient.get<OrganisationNote[]>(`/v1/admin/organisations/${companyId}/notes`);
  return data;
}

export async function addOrganisationNote(companyId: string, body: string): Promise<OrganisationNote> {
  const { data } = await apiClient.post<OrganisationNote>(`/v1/admin/organisations/${companyId}/notes`, { body });
  return data;
}

export async function deleteOrganisationNote(companyId: string, noteId: string): Promise<void> {
  await apiClient.delete(`/v1/admin/organisations/${companyId}/notes/${noteId}`);
}
