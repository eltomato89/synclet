import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Highlighted } from './Highlighted';
import { nameSegments, snippetSegments } from './highlight';

describe('snippetSegments', () => {
  it('turns «…» into marked runs', () => {
    expect(snippetSegments('die «Rechnung» vom «März»')).toEqual([
      { text: 'die ', mark: false }, { text: 'Rechnung', mark: true }, { text: ' vom ', mark: false }, { text: 'März', mark: true },
    ]);
  });

  it('leaves unbalanced markers as text', () => {
    expect(snippetSegments('a « b')).toEqual([{ text: 'a « b', mark: false }]);
    expect(snippetSegments('«x» and » y')).toEqual([{ text: 'x', mark: true }, { text: ' and » y', mark: false }]);
  });

  it('renders HTML in a snippet as text, never as elements', () => {
    const { container } = render(<Highlighted segments={snippetSegments('<img src=x onerror="alert(1)"> «<b>Rechnung</b>» <script>alert(2)</script>')} />);
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container.querySelector('mark')?.textContent).toBe('<b>Rechnung</b>');
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('nameSegments', () => {
  it('marks case- and accent-insensitive occurrences', () => {
    expect(nameSegments('Über-uber.txt', 'UBER')).toEqual([
      { text: 'Über', mark: true }, { text: '-', mark: false }, { text: 'uber', mark: true }, { text: '.txt', mark: false },
    ]);
  });

  it('keeps names without a literal match unmarked', () => {
    expect(nameSegments('Rechnung.pdf', 'Rechnnug')).toEqual([{ text: 'Rechnung.pdf', mark: false }]);
    expect(nameSegments('a.txt', '   ')).toEqual([{ text: 'a.txt', mark: false }]);
  });

  it('handles characters that fold to several units and astral characters', () => {
    expect(nameSegments('🎉 Straße', 'strasse')).toEqual([{ text: '🎉 Straße', mark: false }]);
    expect(nameSegments('🎉 café', 'CAFE')).toEqual([{ text: '🎉 ', mark: false }, { text: 'café', mark: true }]);
  });
});
