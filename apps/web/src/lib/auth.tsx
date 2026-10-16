import type { AuthResponse, PublicUser, SetupStatus } from '@synclet/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import {
  api, broadcastLogout, broadcastSession, getSession, isTransientError, onAuthChange, refreshSession, setAccessToken,
} from './api';
import { clearUploadFingerprints } from '@/features/files/uploads';

/** `error`: the server could not be reached (or failed) while checking the session; offer a retry. */
type Status = 'loading' | 'anonymous' | 'authenticated' | 'needs-setup' | 'error';
interface AuthCtx {
  user: PublicUser | null;
  status: Status;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  completeSetup(input: { username: string; displayName: string; email?: string; password: string }): Promise<void>;
  /** Re-runs the initial session check (after `error`, or when setup turned out to be done already). */
  retry(): void;
}
const Ctx = createContext<AuthCtx | null>(null);

type ProbeResult = 'needs-setup' | 'anonymous' | 'authenticated' | 'error';

// The initial session probe runs once per page load. React StrictMode mounts effects twice in dev;
// two refresh calls would rotate the refresh token twice and trip reuse detection on the server.
let bootstrap: Promise<ProbeResult> | null = null;
function probeSession(): Promise<ProbeResult> {
  bootstrap ??= (async (): Promise<ProbeResult> => {
    const s = await api<SetupStatus>('/setup/status');
    if (s.needsSetup) return 'needs-setup';
    return (await refreshSession()) ? 'authenticated' : 'anonymous';
  })().catch((e: unknown): ProbeResult => (isTransientError(e) ? 'error' : 'anonymous'));
  return bootstrap;
}

/** Test hook: forget the memoised probe. */
export function resetSessionProbe() { bootstrap = null; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [attempt, setAttempt] = useState(0);
  const accept = useCallback((r: AuthResponse | null) => {
    setAccessToken(r?.accessToken ?? null);
    setUser(r?.user ?? null);
    setStatus(r ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    const off = onAuthChange(accept);
    return () => { off(); };
  }, [accept]);

  useEffect(() => {
    let alive = true;
    void probeSession().then((s) => {
      if (!alive) return;
      if (s === 'authenticated') {
        const current = getSession();
        if (current) accept(current);
        else setStatus('anonymous');
      } else {
        setStatus(s);
      }
    });
    return () => { alive = false; };
  }, [accept, attempt]);

  const establish = (r: AuthResponse) => { accept(r); broadcastSession(r); };

  const value: AuthCtx = {
    user, status,
    login: async (login, password) => establish(await api<AuthResponse>('/auth/login', { method: 'POST', json: { login, password } })),
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      clearUploadFingerprints();
      accept(null);
      broadcastLogout();
    },
    completeSetup: async (input) => establish(await api<AuthResponse>('/setup', { method: 'POST', json: input })),
    retry: () => {
      bootstrap = null;
      setStatus('loading');
      setAttempt((a) => a + 1);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
