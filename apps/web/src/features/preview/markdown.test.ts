import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

const dom = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('markdown sanitizer', () => {
  it('renders markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text and `code`.\n\n- a\n- b');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(dom(html).querySelectorAll('li')).toHaveLength(2);
  });

  it('strips <script> and inline event handlers', () => {
    const html = renderMarkdown('Hi\n\n<script>alert(1)</script>\n\n<div onclick="alert(2)">x</div>\n\n<p onmouseover="alert(3)">y</p>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/alert/);
    expect(html).not.toMatch(/on(click|mouseover)=/i);
  });

  it('removes images entirely (markdown and raw HTML, including onerror payloads)', () => {
    const html = renderMarkdown('![tracker](https://evil.example/pixel.png)\n\n<img src=x onerror="alert(1)">\n\n<picture><source srcset="https://e.x/a.png"></picture>');
    const d = dom(html);
    expect(d.querySelector('img, picture, source')).toBeNull();
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('evil.example');
  });

  it('drops javascript: and other unsafe link targets but keeps the text', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) [data](data:text/html,<b>x</b>) [rel](./other.md) <a href="JaVaScRiPt:alert(1)">raw</a>');
    const links = [...dom(html).querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['click', 'data', 'rel', 'raw']);
    for (const a of links) expect(a.hasAttribute('href')).toBe(false);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('opens http(s) and mailto links in a new tab without opener or referrer', () => {
    const a = dom(renderMarkdown('[site](https://example.com) <mailto:jens@example.com>')).querySelectorAll('a');
    expect(a[0].getAttribute('href')).toBe('https://example.com');
    expect(a[0].getAttribute('target')).toBe('_blank');
    expect(a[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(a[1].getAttribute('href')).toBe('mailto:jens@example.com');
  });

  it('removes iframes, forms, styles and embedded SVG', () => {
    const html = renderMarkdown('<iframe src="https://e.x"></iframe><form action="https://e.x"><input type="text"><input type="password"></form><style>body{display:none}</style><svg><script>alert(1)</script></svg><span style="position:fixed">s</span>');
    const d = dom(html);
    expect(d.querySelector('iframe, form, input, style, svg, script')).toBeNull();
    expect(d.querySelector('[style]')).toBeNull();
  });

  it('keeps GFM task-list checkboxes, disabled', () => {
    const d = dom(renderMarkdown('- [x] done\n- [ ] open\n\n<input type="checkbox" onclick="alert(1)" name="x">'));
    const boxes = [...d.querySelectorAll('input')];
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b.type).toBe('checkbox');
      expect(b.disabled).toBe(true);
      expect(b.hasAttribute('onclick') || b.hasAttribute('name')).toBe(false);
    }
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });
});
