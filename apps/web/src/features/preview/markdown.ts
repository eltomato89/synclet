import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Markdown → sanitized HTML. Loaded as its own chunk (marked + DOMPurify) by MarkdownViewer.
 *
 * - No raw HTML survives that could run script: DOMPurify strips `<script>`, event handlers,
 *   `javascript:`/`data:` URLs, forms, frames and embedded SVG/MathML.
 * - No external requests: images (and other media) are removed, not just left unloaded, so a
 *   README cannot ping a tracker or show remote content.
 * - GFM task lists keep their checkboxes: `input` survives only as a disabled checkbox.
 * - Links open in a new tab without referrer/opener; only http(s) and mailto links are kept,
 *   relative links (which would point into the app) lose their href.
 */
const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'style', 'link', 'meta', 'base', 'form', 'button', 'textarea', 'select'];
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
  const body = sanitizer().sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'srcset', 'src', 'action', 'formaction', 'xlink:href', 'name', 'value', 'form'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  }) as HTMLElement;
  for (const input of body.querySelectorAll('input')) {
    if (input.getAttribute('type')?.toLowerCase() !== 'checkbox') { input.remove(); continue; }
    for (const attr of [...input.attributes]) if (!['type', 'checked'].includes(attr.name)) input.removeAttribute(attr.name);
    input.setAttribute('disabled', '');
  }
  return body.innerHTML;
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  return sanitizeHtml(html);
}
