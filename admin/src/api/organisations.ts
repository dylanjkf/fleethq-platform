import { apiClient } from './client';
import type { ImpersonationResult, OrganisationDetail, OrganisationSummary, Paginated } from './types';

export interface ListOrganisationsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'active' | 'suspended' | 'archived';
}

export async function listOrganisations(params: ListOrganisationsParams): Promise<Paginated<OrganisationSummary>> {
  const { data } = await apiClient.get<Paginated<OrganisationSummary>>('/v1/admin/organisations', { params });
  return data;
}

export async function getOrganisation(id: string): Promise<OrganisationDetail> {
  const { data } = await apiClient.get<OrganisationDetail>(`/v1/admin/organisations/${id}`);
  return data;
}

export async function suspendOrganisation(id: string, reason: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${id}/suspend`, { reason });
}

export async function restoreOrganisation(id: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${id}/restore`);
}

export async function archiveOrganisation(id: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${id}/archive`);
}

export async function unarchiveOrganisation(id: string): Promise<void> {
  await apiClient.post(`/v1/admin/organisations/${id}/unarchive`);
}

export async function updateTrial(id: string, trialEndsAt: string | null): Promise<{ trialEndsAt: string | null }> {
  const { data } = await apiClient.patch<{ trialEndsAt: string | null }>(`/v1/admin/organisations/${id}/trial`, { trialEndsAt });
  return data;
}

export async function impersonateUser(id: string, userId: string): Promise<ImpersonationResult> {
  const { data } = await apiClient.post<ImpersonationResult>(`/v1/admin/organisations/${id}/impersonate`, { userId });
  return data;
}

export interface CreateOrganisationUserInput {
  username: string;
  fullName: string;
  roleId: string;
  email?: string;
  password?: string;
}

export async function createOrganisationUser(id: string, input: CreateOrganisationUserInput): Promise<{ userId: string; username: string; invited: boolean }> {
  const { data } = await apiClient.post<{ userId: string; username: string; invited: boolean }>(`/v1/admin/organisations/${id}/users`, input);
  return data;
}

export async function listOrganisationRoles(id: string): Promise<{ id: string; name: string }[]> {
  const { data } = await apiClient.get<{ id: string; name: string }[]>(`/v1/admin/organisations/${id}/roles`);
  return data;
}
