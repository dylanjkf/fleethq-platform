import { apiClient } from './client';
import type { FeatureFlag, OrganisationFeatureFlag } from './types';

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const { data } = await apiClient.get<FeatureFlag[]>('/v1/admin/feature-flags');
  return data;
}

export interface CreateFeatureFlagInput {
  key: string;
  name: string;
  description: string;
  globalEnabled?: boolean;
}

export async function createFeatureFlag(input: CreateFeatureFlagInput): Promise<FeatureFlag> {
  const { data } = await apiClient.post<FeatureFlag>('/v1/admin/feature-flags', input);
  return data;
}

export async function updateFeatureFlag(id: string, input: Partial<Omit<CreateFeatureFlagInput, 'key'>>): Promise<FeatureFlag> {
  const { data } = await apiClient.patch<FeatureFlag>(`/v1/admin/feature-flags/${id}`, input);
  return data;
}

export async function deleteFeatureFlag(id: string): Promise<void> {
  await apiClient.delete(`/v1/admin/feature-flags/${id}`);
}

export async function listOrganisationFeatureFlags(companyId: string): Promise<OrganisationFeatureFlag[]> {
  const { data } = await apiClient.get<OrganisationFeatureFlag[]>(`/v1/admin/organisations/${companyId}/feature-flags`);
  return data;
}

export async function setFeatureFlagOverride(companyId: string, flagKey: string, enabled: boolean): Promise<void> {
  await apiClient.put(`/v1/admin/organisations/${companyId}/feature-flags/${flagKey}`, { enabled });
}

export async function clearFeatureFlagOverride(companyId: string, flagKey: string): Promise<void> {
  await apiClient.delete(`/v1/admin/organisations/${companyId}/feature-flags/${flagKey}`);
}
