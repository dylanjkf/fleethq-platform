import { apiClient } from './client';
import type { AnalyticsOverview, DailySignup, TrialExpiring } from './types';

export async function getOverview(): Promise<AnalyticsOverview> {
  const { data } = await apiClient.get<AnalyticsOverview>('/v1/admin/analytics/overview');
  return data;
}

export async function getDailySignups(days = 30): Promise<DailySignup[]> {
  const { data } = await apiClient.get<DailySignup[]>('/v1/admin/analytics/signups', { params: { days } });
  return data;
}

export async function getTrialsExpiring(days = 7): Promise<TrialExpiring[]> {
  const { data } = await apiClient.get<TrialExpiring[]>('/v1/admin/analytics/trials-expiring', { params: { days } });
  return data;
}
