import { useEffect, useMemo, useState } from 'react';
import { Loading, Sheet, TruncatedNote, usePreviewText, type ViewerProps } from './common';

/**
 * Source code with line numbers, highlighted by highlight.js core and only the languages the
 * server reports (a separate chunk, loaded on first use). Until the chunk is there, the code is
 * shown as plain text so nothing jumps.
 */
export function CodeViewer({ source, onUnavailable, onDownload }: ViewerProps) {
  const state = usePreviewText(source, onUnavailable);
  const text = state.status === 'ready' ? state.data.text : null;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (text === null) return;
    let live = true;
    import('../highlight').then(
      ({ highlight }) => { if (live) setHtml(highlight(text, source.language)); },
      () => { /* chunk failed to load: stay on plain text */ },
    );
    return () => { live = false; };
  }, [text, source.language]);

  const lines = useMemo(() => {
    if (text === null) return 0;
    const n = text.split('\n').length;
    return text.endsWith('\n') ? n - 1 : n;
  }, [text]);

  if (state.status !== 'ready') return state.status === 'loading' ? <Loading className="size-full" /> : null;
  return (
    <Sheet footer={state.data.truncated && <TruncatedNote onDownload={onDownload} />}>
      <div className="code-view flex min-w-max py-5 font-mono text-[0.8125rem] leading-[1.6]">
        <div aria-hidden className="sticky left-0 shrink-0 bg-background pr-4 pl-5 text-right text-muted-foreground/60 tabular-nums select-none">
          {Array.from({ length: Math.max(1, lines) }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        {html !== null
          ? <pre className="hljs pr-8"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
          : <pre className="pr-8"><code>{text}</code></pre>}
      </div>
    </Sheet>
  );
}
