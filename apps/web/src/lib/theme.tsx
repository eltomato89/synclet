import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'synclet.theme';

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage unavailable (private mode, blocked) */ }
  return 'system';
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** Applies the `dark` class on <html>. Called once before the first render to avoid a flash. */
export function applyTheme(pref: ThemePreference): 'light' | 'dark' {
  const resolved = pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  return resolved;
}

interface ThemeCtx { theme: ThemePreference; resolvedTheme: 'light' | 'dark'; setTheme(t: ThemePreference): void }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readThemePreference);
  const [resolvedTheme, setResolved] = useState<'light' | 'dark'>(() => applyTheme(theme));

  useEffect(() => {
    setResolved(applyTheme(theme));
    if (theme !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setResolved(applyTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemePreference) => {
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
    setThemeState(t);
  }, []);

  return <Ctx.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
