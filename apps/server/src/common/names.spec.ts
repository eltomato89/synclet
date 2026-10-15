import {
  assignDisplayNames, freeName, isIgnored, isTempName, nameKey, splitExt, tempName, trashStagingName, validateName, withSuffix,
} from './names';

const d = (s: number) => new Date(2026, 0, 1, 0, 0, s);

describe('names', () => {
  it('nameKey folds case and unicode normalization', () => {
    expect(nameKey('Äpfel.TXT')).toBe(nameKey('äpfel.txt'.replace('ä', 'Ä')));
    expect(nameKey('Report.PDF')).toBe('report.pdf');
  });

  it.each([
    ['', 'empty'], ['.', 'empty'], ['..', 'empty'],
    ['a/b', 'forbidden_char'], ['a\\b', 'forbidden_char'], ['a:b', 'forbidden_char'], ['a*b', 'forbidden_char'],
    ['a?b', 'forbidden_char'], ['a"b', 'forbidden_char'], ['a<b', 'forbidden_char'], ['a|b', 'forbidden_char'],
    ['tab\tname', 'forbidden_char'],
    ['name.', 'trailing'], ['name ', 'trailing'],
    ['CON', 'reserved'], ['con.txt', 'reserved'], ['LPT1', 'reserved'], ['com9.log', 'reserved'],
    ['x'.repeat(256), 'too_long'], ['ü'.repeat(128), 'too_long'],
    ['.DS_Store', 'ignored'], ['Thumbs.db', 'ignored'], ['~$doc.docx', 'ignored'], ['.synclet-tmp-abc', 'ignored'],
    ['.synclet-trash-0123abcd', 'ignored'],
  ])('validateName(%j) = %s', (name, err) => {
    expect(validateName(name)).toBe(err);
  });

  it.each(['Report 2026.pdf', '.env', 'Ünïcödé 🚀.txt', 'console.log', 'a'.repeat(255), '.hidden'])('accepts %j', (name) => {
    expect(validateName(name)).toBeNull();
  });

  it('ignores OS junk and temp files', () => {
    for (const n of ['.DS_Store', '._foo', '.Spotlight-V100', '.Trashes', '.fseventsd', 'Thumbs.db', 'desktop.ini',
      '$RECYCLE.BIN', '~$x.docx', '~WRL0001.tmp', '.~lock.x.odt#', '@eaDir', '#recycle', 'lost+found', '.synclet-tmp-1a2b']) {
      expect(isIgnored(n)).toBe(true);
    }
    expect(isIgnored('notes.txt')).toBe(false);
    expect(isTempName(tempName('k3j4'))).toBe(true);
  });

  it('ignores trash staging names (and never treats them as temp files)', () => {
    const staged = trashStagingName('3f2c1a9e-0b1d-4c2e-9f00-123456789abc');
    expect(staged).toBe('.synclet-trash-3f2c1a9e0b1d4c2e9f00123456789abc');
    expect(isIgnored(staged)).toBe(true);
    expect(isIgnored(`${staged}-partial-ab12`)).toBe(true);
    expect(validateName(staged)).toBe('ignored');
    expect(isTempName(staged)).toBe(false);
  });

  it('splits extensions at the last dot, not at position 0', () => {
    expect(splitExt('a.tar.gz')).toEqual({ base: 'a.tar', ext: '.gz' });
    expect(splitExt('.env')).toEqual({ base: '.env', ext: '' });
    expect(splitExt('README')).toEqual({ base: 'README', ext: '' });
  });

  it('adds suffixes before the extension (files) or at the end (folders)', () => {
    expect(withSuffix('a.txt', 2, false)).toBe('a (2).txt');
    expect(withSuffix('v1.2', 3, true)).toBe('v1.2 (3)');
  });

  it('freeName returns the first free variant', () => {
    expect(freeName('a.txt', new Set(['a.txt', 'a (2).txt']), false)).toBe('a (3).txt');
    expect(freeName('new', new Set(), true)).toBe('new');
  });

  it('assignDisplayNames: folders first, older first, genuine names before suffixes', () => {
    const map = assignDisplayNames([
      { id: 'f3', name: 'a (2).txt', type: 'file', createdAt: d(3) },
      { id: 'f2', name: 'A.txt', type: 'file', createdAt: d(2) },
      { id: 'f1', name: 'a.txt', type: 'file', createdAt: d(1) },
      { id: 'd1', name: 'A.TXT', type: 'folder', createdAt: d(9) },
    ]);
    expect(map.get('d1')).toBe('A.TXT');
    expect(map.get('f3')).toBe('a (2).txt');
    expect(map.get('f1')).toBe('a (3).txt');
    expect(map.get('f2')).toBe('A (4).txt');
  });

  it('assignDisplayNames is independent of input order', () => {
    const sibs = [
      { id: 'x', name: 'Doc.md', type: 'file' as const, createdAt: d(1) },
      { id: 'y', name: 'doc.md', type: 'file' as const, createdAt: d(1) },
    ];
    expect([...assignDisplayNames(sibs)]).toEqual([...assignDisplayNames([...sibs].reverse())].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  });
});
