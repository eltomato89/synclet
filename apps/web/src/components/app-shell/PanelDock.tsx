import { createContext, type ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

const DockCtx = createContext<HTMLElement | null>(null);
const DOCK = 'fixed right-2 bottom-2 left-2 z-30 flex flex-col gap-2 sm:right-4 sm:bottom-4 sm:left-auto sm:w-[22rem]';

/** One fixed column bottom right for the upload and operations panels, so they stack instead of overlapping. */
export function PanelDock({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <DockCtx.Provider value={el}>
      {children}
      <div ref={setEl} className={`${DOCK} pointer-events-none [&>*]:pointer-events-auto`} />
    </DockCtx.Provider>
  );
}

/** Renders a panel into the dock; without a dock (tests, public pages) at the same fixed place. */
export function DockPortal({ children }: { children: ReactNode }) {
  const el = useContext(DockCtx);
  return el ? createPortal(children, el) : <div className={DOCK}>{children}</div>;
}
