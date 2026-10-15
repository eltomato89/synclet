/** A run of text; `mark` runs are rendered inside `<mark>`. */
export interface Segment { text: string; mark: boolean }

const OPEN = '«';
const CLOSE = '»';

function push(out: Segment[], text: string, mark: boolean) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.mark === mark) last.text += text;
  else out.push({ text, mark });
}

/**
 * Splits a server snippet (`ts_headline` with «…» around matches) into plain and marked runs.
 * The snippet is file content and therefore untrusted: it is never parsed as HTML; React renders
 * every run as text, so `<img onerror=…>` in a document stays visible text. Unbalanced markers
 * (a « inside the document itself) degrade to plain text instead of marking the rest.
 */
export function snippetSegments(snippet: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < snippet.length) {
    const open = snippet.indexOf(OPEN, i);
    if (open < 0) break;
    const close = snippet.indexOf(CLOSE, open + 1);
    if (close < 0) break;
    push(out, snippet.slice(i, open), false);
    push(out, snippet.slice(open + 1, close), true);
    i = close + 1;
  }
  push(out, snippet.slice(i), false);
  return out;
}

/** Lower-case without diacritics, per character (as the server's `synclet_unaccent(lower())`). */
const fold = (ch: string) => ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Marks every occurrence of `query` in a file name, ignoring case and accents ("uber" marks
 * "Über"). Typo-tolerant server matches without a literal occurrence stay unmarked.
 */
export function nameSegments(name: string, query: string): Segment[] {
  const q = Array.from(query.trim()).map(fold).join('');
  if (!q) return [{ text: name, mark: false }];
  const chars = Array.from(name);
  let folded = '';
  /** Index in `chars` for every UTF-16 unit of `folded`. */
  const origin: number[] = [];
  chars.forEach((ch, i) => {
    const f = fold(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
  });
  const marked = new Array<boolean>(chars.length).fill(false);
  for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) {
    for (let k = at; k < at + q.length; k++) marked[origin[k]] = true;
  }
  const out: Segment[] = [];
  chars.forEach((ch, i) => push(out, ch, marked[i]));
  return out;
}
