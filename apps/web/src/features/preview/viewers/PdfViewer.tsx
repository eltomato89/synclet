import type { ViewerProps } from './common';

/**
 * PDFs use the browser's own viewer in an iframe.
 *
 * No `sandbox` attribute: Chrome refuses to run its PDF viewer in any sandboxed frame ("This page
 * has been blocked by Chrome"), whatever `allow-*` tokens are given. This is safe because the
 * content route serves `.pdf` files – and only those, the preview kind and the response type both
 * come from the extension – as `application/pdf` with `nosniff`, so the frame can only ever be
 * the browser's PDF viewer, never an HTML document on the app origin. Everything else that could
 * carry script (HTML, SVG) gets the CSP sandbox header from the server and is never framed.
 */
export function PdfViewer({ source }: ViewerProps) {
  return (
    <iframe
      title={source.name}
      src={source.contentUrl}
      referrerPolicy="no-referrer"
      className="size-full max-w-[64rem] rounded-lg bg-white ring-1 ring-white/10"
    />
  );
}
