import { apiClient } from './client';
import type { SystemHealth } from './types';

export async function getSystemHealth(): Promise<SystemHealth> {
  const { data } = await apiClient.get<SystemHealth>('/v1/admin/system/health');
  return data;
}
