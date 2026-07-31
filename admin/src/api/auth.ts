import { apiClient } from './client';
import type { AdminLoginResult, AdminMe, AdminSessionSummary } from './types';

export async function login(username: string, password: string, deviceFingerprint?: string): Promise<AdminLoginResult> {
  const { data } = await apiClient.post<AdminLoginResult>('/v1/admin/auth/login', { username, password, deviceFingerprint });
  return data;
}

export async function verifyMfa(mfaToken: string, code: string, rememberDevice: boolean): Promise<AdminLoginResult> {
  const { data } = await apiClient.post<AdminLoginResult>('/v1/admin/auth/mfa/verify', { mfaToken, code, rememberDevice });
  return data;
}

export async function getMe(): Promise<AdminMe> {
  const { data } = await apiClient.get<AdminMe>('/v1/admin/auth/me');
  return data;
}

export async function listSessions(): Promise<AdminSessionSummary[]> {
  const { data } = await apiClient.get<AdminSessionSummary[]>('/v1/admin/auth/sessions');
  return data;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/v1/admin/auth/sessions/${sessionId}`);
}

export async function logout(): Promise<void> {
  await apiClient.post('/v1/admin/auth/logout');
}

export async function setupMfa(): Promise<{ secret: string; otpauthUrl: string }> {
  const { data } = await apiClient.post<{ secret: string; otpauthUrl: string }>('/v1/admin/auth/mfa/setup');
  return data;
}

export async function enableMfa(code: string): Promise<{ backupCodes: string[] }> {
  const { data } = await apiClient.post<{ backupCodes: string[] }>('/v1/admin/auth/mfa/enable', { code });
  return data;
}

export async function disableMfa(code: string): Promise<void> {
  await apiClient.post('/v1/admin/auth/mfa/disable', { code });
}

/** A device fingerprint generated once per browser and persisted — lets a trusted device skip the MFA challenge. */
export function getOrCreateDeviceFingerprint(): string {
  const KEY = 'fleethq-admin.deviceFingerprint';
  let value = localStorage.getItem(KEY);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(KEY, value);
  }
  return value;
}
