import { apiClient } from './client';
import type { CustomerUserDetail } from './types';

export async function getCustomerUser(userId: string): Promise<CustomerUserDetail> {
  const { data } = await apiClient.get<CustomerUserDetail>(`/v1/admin/customer-users/${userId}`);
  return data;
}

export async function disableCustomerUser(userId: string): Promise<void> {
  await apiClient.post(`/v1/admin/customer-users/${userId}/disable`);
}

export async function reactivateCustomerUser(userId: string): Promise<void> {
  await apiClient.post(`/v1/admin/customer-users/${userId}/reactivate`);
}

export async function unlockCustomerUser(userId: string): Promise<void> {
  await apiClient.post(`/v1/admin/customer-users/${userId}/unlock`);
}

export async function resetCustomerUserMfa(userId: string): Promise<void> {
  await apiClient.post(`/v1/admin/customer-users/${userId}/reset-mfa`);
}

export async function sendCustomerPasswordReset(userId: string): Promise<{ emailOnFile: boolean }> {
  const { data } = await apiClient.post<{ emailOnFile: boolean }>(`/v1/admin/customer-users/${userId}/send-password-reset`);
  return data;
}

export async function resendCustomerVerification(userId: string): Promise<{ emailOnFile: boolean }> {
  const { data } = await apiClient.post<{ emailOnFile: boolean }>(`/v1/admin/customer-users/${userId}/resend-verification`);
  return data;
}
