import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Markdown → sanitized HTML. Loaded as its own chunk (marked + DOMPurify) by MarkdownViewer.
 *
 * - No raw HTML survives that could run script: DOMPurify strips `<script>`, event handlers,
 *   `javascript:`/`data:` URLs, forms, frames and embedded SVG/MathML.
 * - No external requests: images (and other media) are removed, not just left unloaded, so a
 *   README cannot ping a tracker or show remote content.
 * - Links open in a new tab without referrer/opener; only http(s) and mailto links are kept,
 *   relative links (which would point into the app) lose their href.
 */
const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select'];
const SAFE_HREF = /^(https?:|mailto:)/i;

let purify: ReturnType<typeof DOMPurify> | null = null;

function sanitizer() {
  if (purify) return purify;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') ?? '';
    if (!SAFE_HREF.test(href.trim())) {
      node.removeAttribute('href');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  purify = p;
  return p;
}

export function sanitizeHtml(html: string): string {
  return sanitizer().sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'srcset', 'src', 'action', 'formaction', 'xlink:href'],
    ALLOW_DATA_ATTR: false,
  });
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  return sanitizeHtml(html);
}
