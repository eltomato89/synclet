import type { AuthResponse, SyncErrorBody, SyncItem } from '@synclet/shared';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(r: AuthResponse | null) => void>();

export function setAccessToken(t: string | null) { accessToken = t; }
export function getAccessToken() { return accessToken; }
export function onAuthChange(fn: (r: AuthResponse | null) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly item?: SyncItem) { super(message); }
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) { accessToken = null; listeners.forEach((l) => l(null)); return false; }
    const body = (await res.json()) as AuthResponse;
    accessToken = body.accessToken;
    listeners.forEach((l) => l(body));
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(headers as Record<string, string>),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<SyncErrorBody>;
    throw new ApiError(res.status, body.code ?? 'unknown', body.message ?? res.statusText, body.item);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export { refresh as refreshSession };
