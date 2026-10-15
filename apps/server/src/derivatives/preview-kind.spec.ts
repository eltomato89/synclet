import { codeLanguage, extOf, previewKind } from './preview-kind';

describe('previewKind', () => {
  it.each([
    ['photo.JPG', 'image'], ['a.jpeg', 'image'], ['a.png', 'image'], ['a.gif', 'image'], ['a.webp', 'image'],
    ['a.avif', 'image'], ['IMG_1.HEIC', 'image'], ['a.heif', 'image'], ['a.tif', 'image'], ['a.tiff', 'image'], ['a.bmp', 'image'],
    ['logo.svg', 'image'], ['doc.pdf', 'pdf'], ['README.md', 'markdown'], ['x.markdown', 'markdown'],
    ['a.txt', 'text'], ['a.log', 'text'], ['a.csv', 'text'], ['a.tsv', 'text'], ['a.ini', 'text'], ['a.conf', 'text'],
    ['a.ts', 'code'], ['a.tsx', 'code'], ['a.js', 'code'], ['a.jsx', 'code'], ['a.json', 'code'], ['a.py', 'code'], ['a.go', 'code'],
    ['a.rs', 'code'], ['a.java', 'code'], ['a.kt', 'code'], ['a.swift', 'code'], ['a.c', 'code'], ['a.h', 'code'], ['a.cpp', 'code'],
    ['a.cs', 'code'], ['a.rb', 'code'], ['a.php', 'code'], ['a.sh', 'code'], ['a.yml', 'code'], ['a.yaml', 'code'], ['a.toml', 'code'],
    ['a.xml', 'code'], ['index.html', 'code'], ['a.css', 'code'], ['a.sql', 'code'],
    ['a.mp4', 'video'], ['a.m4v', 'video'], ['a.mov', 'video'], ['a.webm', 'video'], ['a.mkv', 'video'],
    ['a.mp3', 'audio'], ['a.m4a', 'audio'], ['a.aac', 'audio'], ['a.wav', 'audio'], ['a.flac', 'audio'], ['a.ogg', 'audio'], ['a.opus', 'audio'],
    ['a.docx', 'none'], ['archive.zip', 'none'], ['Makefile', 'none'], ['.bashrc', 'none'], ['trailing.', 'none'],
  ])('%s → %s', (name, kind) => {
    expect(previewKind(name, null)).toBe(kind);
  });

  it('falls back to the MIME type only for unknown extensions and never yields image from it', () => {
    expect(previewKind('clip.avi', 'video/x-msvideo')).toBe('video');
    expect(previewKind('noext', 'text/plain')).toBe('text');
    expect(previewKind('x.unknown', 'image/svg+xml')).toBe('none');
    expect(previewKind('x.unknown', 'image/png')).toBe('none');
    expect(previewKind('a.txt', 'application/octet-stream')).toBe('text');
  });

  it('codeLanguage maps extensions to highlight.js languages', () => {
    expect(codeLanguage('a.ts')).toBe('typescript');
    expect(codeLanguage('A.PY')).toBe('python');
    expect(codeLanguage('a.yml')).toBe('yaml');
    expect(codeLanguage('a.cs')).toBe('csharp');
    expect(codeLanguage('a.txt')).toBeUndefined();
  });

  it('extOf', () => {
    expect(extOf('a.tar.GZ')).toBe('gz');
    expect(extOf('.hidden')).toBe('');
    expect(extOf('none')).toBe('');
  });
});
