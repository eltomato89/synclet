import { Loading, Sheet, TruncatedNote, usePreviewText, type ViewerProps } from './common';

/** Plain text (txt, log, csv, …): monospace, wrapped, nothing interpreted. */
export function TextViewer({ source, onUnavailable, onDownload }: ViewerProps) {
  const state = usePreviewText(source, onUnavailable);
  if (state.status !== 'ready') return state.status === 'loading' ? <Loading className="size-full" /> : null;
  const { text, truncated } = state.data;
  return (
    <Sheet footer={truncated && <TruncatedNote onDownload={onDownload} />}>
      <pre className="px-6 py-5 font-mono text-[0.8125rem] leading-[1.6] break-words whitespace-pre-wrap md:px-10 md:py-8">{text}</pre>
    </Sheet>
  );
}
