import { useEffect, useState } from 'react';
import { Loading, Sheet, TruncatedNote, usePreviewText, type ViewerProps } from './common';

/**
 * Markdown rendered by marked and sanitized by DOMPurify (a separate chunk). Images are removed,
 * links open in a new tab without referrer – see markdown.ts.
 */
export function MarkdownViewer({ source, onUnavailable, onDownload }: ViewerProps) {
  const state = usePreviewText(source, onUnavailable);
  const text = state.status === 'ready' ? state.data.text : null;
  const [html, setHtml] = useState<{ text: string; html: string } | null>(null);
  const [chunkFailed, setChunkFailed] = useState(false);

  useEffect(() => {
    if (text === null) return;
    let live = true;
    import('../markdown').then(
      ({ renderMarkdown }) => { if (live) setHtml({ text, html: renderMarkdown(text) }); },
      () => { if (live) setChunkFailed(true); },
    );
    return () => { live = false; };
  }, [text]);

  if (state.status === 'error') return null;
  if (state.status === 'loading' || (!chunkFailed && html?.text !== text)) return <Loading className="size-full" />;
  return (
    <Sheet footer={state.data.truncated && <TruncatedNote onDownload={onDownload} />}>
      {chunkFailed || !html
        ? <pre className="px-6 py-5 font-mono text-[0.8125rem] leading-[1.6] break-words whitespace-pre-wrap md:px-12 md:py-10">{text}</pre>
        : <article className="md-view px-6 py-6 md:px-14 md:py-12" dangerouslySetInnerHTML={{ __html: html.html }} />}
    </Sheet>
  );
}
