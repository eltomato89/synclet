import type { AuthResponse, SyncErrorBody, SyncItem } from '@synclet/shared';

let accessToken: string | null = null;
let session: AuthResponse | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(r: AuthResponse | null) => void>();

export function setAccessToken(t: string | null) { accessToken = t; if (!t) session = null; }
export function getAccessToken() { return accessToken; }
/** The last session seen by this tab (from login, setup, refresh or another tab), if any. */
export function getSession() { return session; }
export function onAuthChange(fn: (r: AuthResponse | null) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly item?: SyncItem) { super(message); }
}

/** True for errors that say nothing about the session: server unreachable or failing (5xx). */
export function isTransientError(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.code === 'network' || e.code === 'server_error');
}

function emit(r: AuthResponse | null) {
  session = r;
  accessToken = r?.accessToken ?? null;
  listeners.forEach((l) => l(r));
}

// ---------------------------------------------------------------------------------------------
// Cross-tab coordination. The server rotates the refresh token on every use and revokes ALL
// sessions when a rotated token is reused, so tabs must never refresh concurrently with the
// same cookie. Refreshes are serialised with a Web Lock; results and logouts are shared over a
// BroadcastChannel so a tab waiting for the lock can adopt a token another tab just obtained.
// ---------------------------------------------------------------------------------------------
const CHANNEL_NAME = 'synclet-auth';
const LOCK_NAME = 'synclet-refresh';
/** A token broadcast this recently before our refresh started is considered fresh enough. */
const ADOPT_WINDOW_MS = 5_000;

type AuthMessage = { type: 'session'; at: number; auth: AuthResponse } | { type: 'logout' };

let lastShared: { at: number; auth: AuthResponse } | null = null;
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
channel?.addEventListener('message', (e: MessageEvent<AuthMessage>) => {
  const msg = e.data;
  if (msg?.type === 'session') {
    lastShared = { at: msg.at, auth: msg.auth };
    emit(msg.auth);
  } else if (msg?.type === 'logout') {
    lastShared = null;
    emit(null);
  }
});

function post(msg: AuthMessage) {
  try { channel?.postMessage(msg); } catch { /* channel closed */ }
}

/** Tells other tabs about a new session (after login, setup or refresh). */
export function broadcastSession(auth: AuthResponse) {
  lastShared = { at: Date.now(), auth };
  post({ type: 'session', at: lastShared.at, auth });
}

/** Tells other tabs that the user logged out. */
export function broadcastLogout() {
  lastShared = null;
  post({ type: 'logout' });
}

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn(); // fallback: per-tab single-flight only
  return locks.request(LOCK_NAME, fn) as Promise<T>;
}

/**
 * Obtains a new access token with the refresh cookie.
 * Resolves `true` on success, `false` when the session is gone (401/403: listeners get `null`).
 * Rejects with ApiError `network` / `server_error` on transient failures; the session is kept.
 */
async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const requestedAt = Date.now();
    const tokenBefore = accessToken;
    return withRefreshLock(async () => {
      // Another tab may have refreshed while we waited for the lock: use its token instead of
      // presenting a refresh cookie it has already rotated.
      if (lastShared && lastShared.at >= requestedAt - ADOPT_WINDOW_MS && lastShared.auth.accessToken !== tokenBefore) {
        emit(lastShared.auth);
        return true;
      }
      let res: Response;
      try {
        res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      } catch (e) {
        throw new ApiError(0, 'network', e instanceof Error ? e.message : 'network error');
      }
      if (res.status === 401 || res.status === 403) { emit(null); return false; }
      if (!res.ok) throw new ApiError(res.status, 'server_error', res.statusText || 'refresh failed');
      const body = (await res.json()) as AuthResponse;
      emit(body);
      broadcastSession(body);
      return true;
    });
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'include',
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(headers as Record<string, string>),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', e instanceof Error ? e.message : 'network error');
  }
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<SyncErrorBody>;
    const fallbackCode = res.status >= 500 ? 'server_error' : 'unknown';
    throw new ApiError(res.status, body.code ?? fallbackCode, body.message ?? res.statusText, body.item);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export { refresh as refreshSession };
