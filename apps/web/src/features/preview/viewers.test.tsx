import type { SyncItem } from '@synclet/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import i18n from '@/lib/i18n';
import { QuickLook } from './QuickLook';
import { isPreviewable, type PreviewSource } from './source';
import { PreviewStage, viewerKey } from './viewers';
import { imageCandidates } from './viewers/ImageViewer';

void i18n.changeLanguage('en');
afterEach(cleanup);

const src = (kind: PreviewSource['kind'], name: string, opts: Partial<PreviewSource> & { thumb?: boolean } = {}): PreviewSource => ({
  kind, name, size: 1234, mime: null,
  contentUrl: `/content/${name}?dt=t`,
  downloadUrl: `/content/${name}?dt=t&download=1`,
  thumbnailUrl: (size) => (opts.thumb ? `/thumb/${name}?size=${size}` : null),
  rasterSafe: /\.(jpe?g|png|gif|webp|avif)$/i.test(name),
  loadText: async () => ({ text: 'hello\nworld', truncated: false, encoding: 'utf-8' }),
  ...opts,
});

describe('viewer selection by kind', () => {
  it('maps every kind to its viewer', () => {
    expect(viewerKey(src('image', 'a.jpg'))).toBe('image');
    expect(viewerKey(src('pdf', 'a.pdf'))).toBe('pdf');
    expect(viewerKey(src('text', 'a.txt'))).toBe('text');
    expect(viewerKey(src('markdown', 'a.md'))).toBe('markdown');
    expect(viewerKey(src('code', 'a.ts', { language: 'typescript' }))).toBe('code');
    expect(viewerKey(src('video', 'a.mp4'))).toBe('media');
    expect(viewerKey(src('audio', 'a.mp3'))).toBe('media');
    expect(viewerKey(src('none', 'a.zip'))).toBe('none');
    expect(viewerKey(src('text', 'a.txt', { loadText: undefined }))).toBe('none');
  });

  it('never loads SVG/HEIC/TIFF originals: thumbnail only, or no preview', () => {
    for (const name of ['logo.svg', 'IMG_1.HEIC', 'scan.tiff', 'old.bmp']) {
      expect(viewerKey(src('image', name))).toBe('none');
      const withThumb = src('image', name, { thumb: true });
      expect(viewerKey(withThumb)).toBe('image');
      expect(imageCandidates(withThumb)).toEqual([`/thumb/${name}?size=1024`]);
    }
    expect(imageCandidates(src('image', 'p.jpg', { thumb: true }))).toEqual(['/thumb/p.jpg?size=1024', '/content/p.jpg?dt=t']);
    expect(imageCandidates(src('image', 'p.jpg'))).toEqual(['/content/p.jpg?dt=t']);
  });

  it('renders PDF in an iframe of the browser viewer, media natively with the thumbnail as poster', () => {
    const { container, unmount } = render(<PreviewStage source={src('pdf', 'a.pdf')} />);
    const iframe = container.querySelector('iframe')!;
    // Chrome blocks its PDF viewer in any sandboxed frame (see PdfViewer).
    expect(iframe.hasAttribute('sandbox')).toBe(false);
    expect(iframe.getAttribute('src')).toBe('/content/a.pdf?dt=t');
    unmount();

    const video = render(<PreviewStage source={src('video', 'v.mp4', { thumb: true })} />).container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/content/v.mp4?dt=t');
    expect(video.getAttribute('poster')).toBe('/thumb/v.mp4?size=1024');
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('shows the text, and the no-preview panel with download for kind none', async () => {
    render(<PreviewStage source={src('text', 'a.txt')} />);
    expect(await screen.findByText(/hello/)).toBeInTheDocument();

    const onDownload = vi.fn();
    render(<PreviewStage source={src('none', 'a.zip')} onDownload={onDownload} />);
    expect(screen.getByText('No preview available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalled();
  });

  it('falls back to the no-preview panel when loading the text fails', async () => {
    render(<PreviewStage source={src('code', 'a.ts', { loadText: () => Promise.reject(new Error('415')) })} />);
    expect(await screen.findByText(/preview couldn't be loaded/)).toBeInTheDocument();
  });

  it('highlights code with the lazily loaded highlighter', async () => {
    const { container } = render(<PreviewStage source={src('code', 'a.ts', { language: 'typescript', loadText: async () => ({ text: 'const x = 1;', truncated: true, encoding: 'utf-8' }) })} />);
    await waitFor(() => expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const'));
    expect(screen.getByText(/Only the beginning/)).toBeInTheDocument();
  });
});

describe('isPreviewable', () => {
  const f = (name: string, preview?: SyncItem['preview']) => ({ type: 'file' as const, name, preview });
  it('decides between QuickLook and download', () => {
    expect(isPreviewable(f('a.jpg', { kind: 'image', thumbnail: false }))).toBe(true);
    expect(isPreviewable(f('a.heic', { kind: 'image', thumbnail: false }))).toBe(false);
    expect(isPreviewable(f('a.heic', { kind: 'image', thumbnail: true }))).toBe(true);
    expect(isPreviewable(f('a.pdf', { kind: 'pdf', thumbnail: false }))).toBe(true);
    expect(isPreviewable(f('a.zip', { kind: 'none', thumbnail: false }))).toBe(false);
    expect(isPreviewable(f('a.zip'))).toBe(false);
    expect(isPreviewable({ type: 'folder', name: 'x', preview: undefined })).toBe(false);
  });
});

describe('QuickLook', () => {
  const entries = ['a.zip', 'b.zip', 'c.zip'].map((name, i) => ({ id: `f_${i}`, name, size: 10, mime: null, modifiedAt: '2026-10-15T08:00:00Z' }));
  const resolveSource = (e: { name: string }) => Promise.resolve(src('none', e.name));

  function setup(activeId = 'f_1') {
    const onActiveChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <QuickLook entries={entries} activeId={activeId} open onActiveChange={onActiveChange} onOpenChange={onOpenChange} resolveSource={resolveSource} onDownload={vi.fn()} />
      </TooltipProvider>,
    );
    return { onActiveChange, onOpenChange, dialog: screen.getByRole('dialog') };
  }

  it('steps with ← / → in the given order and closes with Space', async () => {
    const { onActiveChange, onOpenChange, dialog } = setup();
    await screen.findByText('No preview available');
    expect(screen.getByRole('heading', { name: 'b.zip' })).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(document.activeElement).toBe(dialog); // not a header button: Space must not trigger a download
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(onActiveChange).toHaveBeenLastCalledWith('f_2');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(onActiveChange).toHaveBeenLastCalledWith('f_0');
    fireEvent.keyDown(dialog, { key: ' ' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not step past the ends', async () => {
    const { onActiveChange, dialog } = setup('f_2');
    await act(async () => { fireEvent.keyDown(dialog, { key: 'ArrowRight' }); });
    expect(onActiveChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Next file' })).toBeDisabled();
  });
});
