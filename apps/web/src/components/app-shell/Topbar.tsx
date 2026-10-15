import { Menu } from 'lucide-react';
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { LogoMark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { SearchLauncher } from '@/features/search/CommandPalette';

/**
 * Topbar slot: pages render their breadcrumb and actions into the shell's topbar with
 * `useTopbar(node)`. The node lives in a tiny external store that only <Topbar> subscribes to,
 * so updating it never re-renders the page itself (no render loops when `node` is new JSX
 * on every render).
 */
interface TopbarStore {
  get(): ReactNode;
  set(owner: object, node: ReactNode): void;
  clear(owner: object): void;
  subscribe(fn: () => void): () => void;
}

function createTopbarStore(): TopbarStore {
  let owner: object | null = null;
  let node: ReactNode = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((s) => s());
  return {
    get: () => node,
    set(o, n) { owner = o; node = n; emit(); },
    clear(o) { if (owner === o) { owner = null; node = null; emit(); } },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

const TopbarCtx = createContext<TopbarStore | null>(null);

export function TopbarProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createTopbarStore);
  return <TopbarCtx.Provider value={store}>{children}</TopbarCtx.Provider>;
}

/** Shows `node` in the shell's topbar while the calling component is mounted. */
export function useTopbar(node: ReactNode): void {
  const store = useContext(TopbarCtx);
  const owner = useRef({}).current;
  useLayoutEffect(() => { store?.set(owner, node); });
  useLayoutEffect(() => () => store?.clear(owner), [store, owner]);
}

function TopbarSlot() {
  const store = useContext(TopbarCtx);
  const node = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? nullNode, nullNode);
  return <div className="flex min-w-0 flex-1 items-center gap-2">{node}</div>;
}
const noopSubscribe = () => () => {};
const nullNode = () => null;

export function Topbar({ onOpenNavigation }: { onOpenNavigation(): void }) {
  const { t } = useTranslation();
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b px-3 md:px-6">
      <Button variant="ghost" size="icon-sm" className="-ml-1 md:hidden" onClick={onOpenNavigation} aria-label={t('shell.openNavigation')}>
        <Menu />
      </Button>
      <LogoMark className="size-6 md:hidden" />
      <TopbarSlot />
      <div className="ml-1 h-5 w-px shrink-0 bg-border max-sm:hidden" aria-hidden />
      <SearchLauncher />
    </header>
  );
}
