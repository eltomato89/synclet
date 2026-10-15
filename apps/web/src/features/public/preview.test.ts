import { describe, expect, it } from 'vitest';
import { previewKind, publicPreviewSource } from './preview';

const TOKEN = 'tok';
const base = `/api/public/shares/${TOKEN}`;

describe('previewKind', () => {
  it.each([
    ['photo.JPG', null, 'image'], ['logo.svg', 'image/svg+xml', 'image'], ['clip.mp4', null, 'video'], ['song.mp3', null, 'audio'],
    ['doc.pdf', null, 'pdf'], ['README.md', null, 'markdown'], ['main.ts', null, 'code'], ['notes.txt', null, 'text'],
    ['archive.zip', 'application/zip', 'none'], ['noext', 'video/mp4', 'video'], ['noext', 'image/svg+xml', 'none'], ['noext', null, 'none'],
  ])('%s (%s) → %s', (name, mime, kind) => {
    expect(previewKind(name, mime)).toBe(kind);
  });
});

describe('publicPreviewSource', () => {
  const entry = { id: 'f_1', name: 'Strand.png', size: 10, mime: 'image/png', hasThumbnail: true };

  it('builds public content, download and thumbnail URLs', () => {
    const s = publicPreviewSource(TOKEN, entry, true);
    expect(s).toMatchObject({ kind: 'image', name: 'Strand.png', contentUrl: `${base}/items/f_1/content`, downloadUrl: `${base}/items/f_1/content?download=1`, rasterSafe: true });
    expect(s.thumbnailUrl(1024)).toBe(`${base}/items/f_1/thumbnail?size=1024`);
  });

  it('has no download URL when downloads are disabled', () => {
    expect(publicPreviewSource(TOKEN, entry, false).downloadUrl).toBeNull();
  });

  it('has no thumbnail when the server says there is none, and tries it when unknown', () => {
    expect(publicPreviewSource(TOKEN, { ...entry, hasThumbnail: false }, true).thumbnailUrl(256)).toBeNull();
    expect(publicPreviewSource(TOKEN, { ...entry, id: 'f_9', hasThumbnail: undefined }, true).thumbnailUrl(256)).toBe(`${base}/items/f_9/thumbnail?size=256`);
  });

  it('never marks SVG as safe to render from its content URL', () => {
    expect(publicPreviewSource(TOKEN, { ...entry, name: 'x.svg', mime: 'image/svg+xml' }, true).rasterSafe).toBe(false);
  });
});
