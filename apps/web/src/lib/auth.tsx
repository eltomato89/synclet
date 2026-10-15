import type { AuthResponse, PublicUser, SetupStatus } from '@synclet/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, onAuthChange, refreshSession, setAccessToken } from './api';

type Status = 'loading' | 'anonymous' | 'authenticated' | 'needs-setup';
interface AuthCtx {
  user: PublicUser | null;
  status: Status;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  completeSetup(input: { username: string; displayName: string; email?: string; password: string }): Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

// The initial session probe runs once per page load. React StrictMode mounts effects twice in dev;
// two refresh calls would rotate the refresh token twice and trip reuse detection on the server.
let bootstrap: Promise<'needs-setup' | 'anonymous' | 'authenticated'> | null = null;
function probeSession() {
  bootstrap ??= (async () => {
    const s = await api<SetupStatus>('/setup/status');
    if (s.needsSetup) return 'needs-setup' as const;
    return (await refreshSession()) ? ('authenticated' as const) : ('anonymous' as const);
  })().catch(() => 'anonymous' as const);
  return bootstrap;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const accept = useCallback((r: AuthResponse | null) => {
    setAccessToken(r?.accessToken ?? null);
    setUser(r?.user ?? null);
    setStatus(r ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    const off = onAuthChange(accept);
    let alive = true;
    void probeSession().then((s) => {
      if (!alive) return;
      // 'authenticated' is applied by the onAuthChange listener (it carries the user).
      if (s === 'needs-setup') setStatus('needs-setup');
      else if (s === 'anonymous') setStatus('anonymous');
    });
    return () => { alive = false; off(); };
  }, [accept]);

  const value: AuthCtx = {
    user, status,
    login: async (login, password) => accept(await api<AuthResponse>('/auth/login', { method: 'POST', json: { login, password } })),
    logout: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); accept(null); },
    completeSetup: async (input) => accept(await api<AuthResponse>('/setup', { method: 'POST', json: input })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
