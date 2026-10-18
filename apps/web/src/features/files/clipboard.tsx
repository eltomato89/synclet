import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

export interface ClipboardContent { itemIds: string[]; sourceFolderId: string; at: number }
interface ClipboardApi { content: ClipboardContent | null; copy(itemIds: string[], sourceFolderId: string): void; clear(): void }

const Ctx = createContext<ClipboardApi>({ content: null, copy: () => {}, clear: () => {} });
export const useClipboard = () => useContext(Ctx);

/** Synclet's own clipboard for ⌘C / ⌘V between folders: this tab only, gone on reload. */
export function ClipboardProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ClipboardContent | null>(null);
  const value = useMemo<ClipboardApi>(() => ({
    content,
    copy: (itemIds, sourceFolderId) => setContent({ itemIds, sourceFolderId, at: Date.now() }),
    clear: () => setContent(null),
  }), [content]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
