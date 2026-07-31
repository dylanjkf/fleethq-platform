import axios, { type AxiosError } from 'axios';
import { tokenStore } from './token-store';
import type { ApiErrorBody } from './types';

/** Normalized client-side error — status 0 means "no response at all" (network failure), never a real server verdict. */
export class ApiClientError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The admin SPA is a separate deployable from the API (own origin in
 * production, e.g. admin.fleethq.online → api.fleethq.online), same
 * cross-origin reasoning as apps/driveros's client.ts. `VITE_API_BASE`
 * unset falls back to `/`, which vite.config.ts's dev proxy forwards to
 * `http://localhost:3000` — local dev only.
 */
export const apiClient = axios.create({ baseURL: import.meta.env.VITE_API_BASE || '/', timeout: 30_000 });

apiClient.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0;
    const body = error.response?.data?.error;

    if (status === 401) {
      tokenStore.clear();
      onUnauthorized?.();
    }

    const { code = 'NETWORK_ERROR', message = error.message, ...details } = body ?? {};
    return Promise.reject(new ApiClientError(status, code, message, details));
  },
);
