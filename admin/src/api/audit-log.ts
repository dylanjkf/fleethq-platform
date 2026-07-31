import { apiClient } from './client';
import type { AdminAuditLogEntry, Paginated } from './types';

export interface AuditLogSearchParams {
  page?: number;
  pageSize?: number;
  action?: string;
  entityType?: string;
  organisationId?: string;
  adminUserId?: string;
  from?: string;
  to?: string;
}

export async function searchAuditLog(params: AuditLogSearchParams): Promise<Paginated<AdminAuditLogEntry>> {
  const { data } = await apiClient.get<Paginated<AdminAuditLogEntry>>('/v1/admin/audit-log', { params });
  return data;
}
