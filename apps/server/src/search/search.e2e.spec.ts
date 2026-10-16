import type { SearchResponse, SyncItem } from '@synclet/shared';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { writeOffice, writeTextPdf } from '../../test/text-fixtures';
import { itIfTool } from '../../test/tools';
import { AuthService } from '../auth/auth.service';
import { DerivedStore } from '../derivatives/derived-store';
import { HashBackfill } from '../derivatives/hash';
import { JobsService } from '../derivatives/jobs.service';
import { TextIndexer } from '../derivatives/text-index';
import { Thumbnailer } from '../derivatives/thumbnails';
import { WorkerRunner } from '../worker/worker-runner';
import { SearchLanguage } from './search-language';
import { capSnippet } from './search.service';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

describe('search, recent and text preview', () => {
  let ctx: TestContext; let token: string; let eveToken: string; let runner: WorkerRunner;

  const api = (method: string, url: string, opts: { body?: Buffer | string; as?: string; json?: unknown } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
    });
  const upload = async (name: string, body: Buffer | string, opts: { parentId?: string; as?: string } = {}): Promise<SyncItem> => {
    const res = await api('POST', `/items/upload?parentId=${opts.parentId ?? 'root'}&name=${encodeURIComponent(name)}`, { body, as: opts.as });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const folder = async (name: string, parentId = 'root', as?: string): Promise<SyncItem> =>
    (await api('POST', '/items', { json: { parentId, type: 'folder', name }, as })).json();
  const search = async (q: string, extra = '', as?: string): Promise<SearchResponse> => {
    const res = await api('GET', `/search?q=${encodeURIComponent(q)}${extra}`, { as });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const names = (r: SearchResponse) => r.hits.map((h) => h.item.name);
  /** Runs the worker until it has nothing left to do (hashing, enqueueing, thumbnails, text). */
  const drain = async () => { for (let i = 0; i < 50 && (await runner.tick()); i++); };

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken;
    const eve = await createTestUser(ctx, 'eve');
    eveToken = await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: eve.id } }));
    const lang = new SearchLanguage(ctx.prisma, ctx.config);
    runner = new WorkerRunner(ctx.config, new HashBackfill(ctx.prisma, ctx.config), new JobsService(ctx.prisma, ctx.config),
      new Thumbnailer(ctx.app.get(DerivedStore), ctx.config), new TextIndexer(ctx.prisma, lang));
  });
  afterEach(async () => { await ctx.close(); });

  describe('name search', () => {
    it('exact name, typo, accent- and case-insensitive; folders too; path is the parent folder', async () => {
      const docs = await folder('Dokumente');
      await upload('Rechnung 2024.pdf', '%PDF-1.4 nothing', { parentId: docs.id });
      await upload('Café Menü.txt', 'x');
      await upload('unrelated.txt', 'x');
      const exact = await search('Rechnung 2024.pdf');
      expect(names(exact)).toEqual(['Rechnung 2024.pdf']);
      expect(exact.hits[0]).toMatchObject({ path: 'Dokumente', matched: 'name', snippet: null });
      expect(names(await search('Rechnnug'))).toEqual(['Rechnung 2024.pdf']);
      expect(names(await search('rechnung'))).toEqual(['Rechnung 2024.pdf']);
      expect(names(await search('cafe'))).toEqual(['Café Menü.txt']);
      expect(names(await search('CAFÉ menu'))).toEqual(['Café Menü.txt']);
      expect(names(await search('dokumente'))).toEqual(['Dokumente']);
      expect((await search('Café Menü.txt')).hits[0].path).toBe('');
      expect(await search('zzzqqq')).toEqual({ hits: [], total: 0 });
    });

    it('LIKE wildcards in the query are literal', async () => {
      await upload('100% done.txt', 'x');
      await upload('a_b.txt', 'x');
      await upload('axb.txt', 'x');
      expect(names(await search('a_b'))).toEqual(['a_b.txt']);
      expect(names(await search('100%'))).toEqual(['100% done.txt']);
    });

    it('validates q, clamps limit, pages with offset and total', async () => {
      expect((await api('GET', '/search?q=')).statusCode).toBe(400);
      expect((await api('GET', '/search?q=%20%20')).statusCode).toBe(400);
      expect((await api('GET', '/search')).statusCode).toBe(400);
      expect((await api('GET', `/search?q=${'a'.repeat(201)}`)).statusCode).toBe(400);
      expect((await api('GET', `/search?q=${'a'.repeat(200)}`)).statusCode).toBe(200);
      for (let i = 0; i < 5; i++) await upload(`report-${i}.txt`, 'x');
      const p1 = await search('report', '&limit=2');
      const p2 = await search('report', '&limit=2&offset=2');
      const p3 = await search('report', '&limit=2&offset=4');
      expect(p1.total).toBe(5);
      expect([...names(p1), ...names(p2), ...names(p3)].sort()).toEqual(['report-0.txt', 'report-1.txt', 'report-2.txt', 'report-3.txt', 'report-4.txt']);
      expect(await search('report', '&offset=50')).toEqual({ hits: [], total: 5 });
      expect((await search('report', '&limit=0')).hits).toHaveLength(1);
      expect((await search('report', '&limit=999')).hits).toHaveLength(5);
    });

    it('the name predicates can use Item_name_trgm_idx (same expression, partial predicate)', async () => {
      // Enough live rows with statistics that an index is worth it; then the same predicates as
      // SearchService (expression + partial predicate of the index) must be planned on the trigram index.
      const owner = await ctx.prisma.user.findFirstOrThrow({ where: { username: 'jens' } });
      await ctx.prisma.$executeRaw`
        INSERT INTO "Item" (id, "spaceId", type, name, "nameKey", path, mtime, "updatedAt")
        SELECT gen_random_uuid(), ${owner.id}::uuid, 'file', n, lower(n), n, now(), now()
        FROM (SELECT 'file-' || g || '-' || md5(g::text) || '.txt' AS n FROM generate_series(1, 5000) g) s`;
      await ctx.prisma.$executeRawUnsafe('ANALYZE "Item"');
      const plan = await ctx.prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM "Item" i WHERE i."spaceId" = $1::uuid AND i."deletedAt" IS NULL
           AND (synclet_unaccent(lower(i.name)) % synclet_unaccent(lower($2))
             OR synclet_unaccent(lower($2)) <% synclet_unaccent(lower(i.name))
             OR synclet_unaccent(lower(i.name)) LIKE '%' || synclet_unaccent(lower($2)) || '%')`,
        owner.id, 'rechnung');
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('Item_name_trgm_idx');
    });
  });

  describe('content search', () => {
    it('finds words in text files; snippet with markers; matched name/content/both; accent-insensitive', async () => {
      await upload('notes.txt', 'Meeting notes: the quarterly Steuererklärung is due next week, please prepare everything.');
      await upload('steuererklarung.md', '# Steuererklärung\n\nChecklist for the tax return.');
      await upload('other.txt', 'nothing relevant here');
      await drain();
      const res = await search('Steuererklärung');
      const byName = Object.fromEntries(res.hits.map((h) => [h.item.name, h]));
      expect(Object.keys(byName).sort()).toEqual(['notes.txt', 'steuererklarung.md']);
      expect(byName['notes.txt'].matched).toBe('content');
      expect(byName['steuererklarung.md'].matched).toBe('both');
      expect(res.hits[0].item.name).toBe('steuererklarung.md'); // name match ranks first
      expect(byName['notes.txt'].snippet).toContain('«Steuererklärung»');
      expect(byName['notes.txt'].snippet).not.toContain('<');
      // The query is unaccented like the indexed text.
      expect(names(await search('steuererklarung')).sort()).toEqual(['notes.txt', 'steuererklarung.md']);
      expect(names(await search('quarterly'))).toEqual(['notes.txt']);
      // websearch syntax (the other file only matches by name similarity here)
      const phrase = await search('"quarterly Steuererklärung"');
      expect(phrase.hits.filter((h) => h.matched !== 'name').map((h) => h.item.name)).toEqual(['notes.txt']);
      expect(await search('quarterly -prepare')).toEqual({ hits: [], total: 0 });
    });

    itIfTool('unzip', 'finds a word inside a docx', async () => {
      const tmp = path.join(ctx.config.metaRoot, 'Angebot.docx');
      await writeOffice(tmp, 'docx', ['Angebot für Gartenarbeiten', 'Gesamtsumme 1200 Euro']);
      await upload('Angebot.docx', await readFile(tmp));
      await drain();
      const res = await search('Gartenarbeiten');
      expect(names(res)).toEqual(['Angebot.docx']);
      expect(res.hits[0]).toMatchObject({ matched: 'content' });
      expect(res.hits[0].snippet).toContain('«Gartenarbeiten»');
    });

    itIfTool('pdftotext', 'finds a word inside a pdf', async () => {
      const tmp = path.join(ctx.config.metaRoot, 'invoice.pdf');
      await writeTextPdf(tmp, 'Invoice Hausverwaltung Betrag 42 Euro');
      await upload('scan-001.pdf', await readFile(tmp));
      await drain();
      expect(names(await search('Hausverwaltung'))).toEqual(['scan-001.pdf']);
    });

    it('extracted text is stored per content hash with a tsvector; the job ends done/unsupported', async () => {
      const item = await upload('a.txt', 'alpha beta gamma');
      const bin = Buffer.alloc(2048);
      for (let i = 0; i < bin.length; i++) bin[i] = (i * 7919) % 256;
      const binItem = await upload('b.txt', bin);
      await drain();
      const [row] = await ctx.prisma.$queryRaw<{ content: string; tsv: string }[]>`SELECT content, tsv::text AS tsv FROM "ItemText" WHERE sha = ${item.sha256}`;
      expect(row.content).toBe('alpha beta gamma');
      expect(row.tsv).toContain("'gamma'");
      expect(await ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha: item.sha256!, kind: 'text' } } })).toMatchObject({ status: 'done' });
      expect(await ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha: binItem.sha256!, kind: 'text' } } })).toMatchObject({ status: 'unsupported' });
      expect(await ctx.prisma.itemText.count({ where: { sha: binItem.sha256! } })).toBe(0);
    });

    itIfTool('unzip', 'an unreadable office file fails its text job without retries', async () => {
      const f = await upload('broken.docx', 'not a zip at all');
      await drain();
      expect(await ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha: f.sha256!, kind: 'text' } } })).toMatchObject({ status: 'failed', attempts: 1 });
    });

    it('snippets come from the first 64 KiB only and are capped at 300 characters', async () => {
      await upload('late.txt', `${'filler '.repeat(20_000)}latecomer word`);
      await upload('long.txt', `marker ${'x'.repeat(5000)}`);
      await drain();
      const late = await search('latecomer');
      expect(names(late)).toEqual(['late.txt']); // still found through the full tsvector
      expect(late.hits[0].snippet).not.toContain('«');
      const long = (await search('marker')).hits[0].snippet!;
      expect(long.startsWith('«marker»')).toBe(true);
      expect([...long].length).toBeLessThanOrEqual(301);
      expect(capSnippet(`a «${'b'.repeat(400)}» c`)).toBe(`a «${'b'.repeat(297)}»…`);
      expect(capSnippet('short «hit»')).toBe('short «hit»');
    });

    it('text too large for one tsvector is indexed by its prefix', async () => {
      // ~1 MiB of distinct words exceeds Postgres' 1 MB tsvector limit.
      const words: string[] = [];
      for (let i = 0, len = 0; len < 1000_000; i++) {
        const w = `w${i.toString(36)}x${((i * 2654435761) % 4294967296).toString(36)}`;
        words.push(w); len += w.length + 1;
      }
      await upload('huge.txt', `needleword ${words.join(' ')}`);
      await drain();
      expect(names(await search('needleword'))).toEqual(['huge.txt']);
    }, 60_000);
  });

  describe('leaks (Review Focus 5)', () => {
    it("never returns another user's items, by name or by content", async () => {
      await upload('secret-plan.txt', 'confidential zeppelin blueprint', { as: eveToken });
      await drain();
      expect(await search('secret-plan')).toEqual({ hits: [], total: 0 });
      expect(await search('zeppelin')).toEqual({ hits: [], total: 0 });
      expect(names(await search('zeppelin', '', eveToken))).toEqual(['secret-plan.txt']);
    });

    it('two users with the same content only see their own items', async () => {
      const mine = await upload('mine.txt', 'shared words aardvark');
      const theirs = await upload('theirs.txt', 'shared words aardvark', { as: eveToken });
      expect(mine.sha256).toBe(theirs.sha256);
      await drain();
      expect(await ctx.prisma.itemText.count()).toBe(1);
      expect(names(await search('aardvark'))).toEqual(['mine.txt']);
      expect(names(await search('aardvark', '', eveToken))).toEqual(['theirs.txt']);
      // Eve trashes hers: mine is still found, hers is not found for her.
      await api('DELETE', `/items/${theirs.id}`, { as: eveToken });
      expect(names(await search('aardvark'))).toEqual(['mine.txt']);
      expect(await search('aardvark', '', eveToken)).toEqual({ hits: [], total: 0 });
    });

    it('trashed files are never returned (directly or inside a trashed folder), by name or content', async () => {
      const f = await upload('obsolete-contract.txt', 'platypus clause');
      const dir = await folder('Archive');
      await upload('inner.txt', 'wombat clause', { parentId: dir.id });
      await drain();
      expect(names(await search('platypus'))).toEqual(['obsolete-contract.txt']);
      expect(names(await search('wombat'))).toEqual(['inner.txt']);
      expect((await api('DELETE', `/items/${f.id}`)).statusCode).toBe(204);
      expect((await api('DELETE', `/items/${dir.id}`)).statusCode).toBe(204);
      for (const q of ['platypus', 'obsolete-contract', 'wombat', 'inner.txt', 'Archive', 'clause']) {
        expect(await search(q)).toEqual({ hits: [], total: 0 });
      }
      expect(await ctx.prisma.itemText.count()).toBe(2); // the text stays until GC; it is just not reachable
    });

    it('recent and preview-text never expose other users or trashed files', async () => {
      const f = await upload('gone.txt', 'x');
      await upload('eve.txt', 'x', { as: eveToken });
      await api('DELETE', `/items/${f.id}`);
      expect((await api('GET', '/recent')).json()).toEqual([]);
      const eveFile = ((await api('GET', '/recent', { as: eveToken })).json() as SyncItem[])[0];
      const res = await api('GET', `/items/${eveFile.id}/preview-text`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
      expect((await api('GET', `/items/${f.id}/preview-text`)).statusCode).toBe(404);
    });
  });

  it('folder scoping restricts to the subtree (root = everything)', async () => {
    const a = await folder('A');
    const sub = await folder('Sub', a.id);
    const ab = await folder('AB'); // same prefix, outside A
    await upload('kiwi-1.txt', 'x', { parentId: a.id });
    await upload('kiwi-2.txt', 'x', { parentId: sub.id });
    await upload('kiwi-3.txt', 'x', { parentId: ab.id });
    await upload('kiwi-4.txt', 'x');
    expect(names(await search('kiwi', `&folder=${a.id}`)).sort()).toEqual(['kiwi-1.txt', 'kiwi-2.txt']);
    expect((await search('kiwi', `&folder=${sub.id}`)).hits[0]).toMatchObject({ path: 'A/Sub' });
    expect(names(await search('kiwi', '&folder=root'))).toHaveLength(4);
    const eveDir = await folder('E', 'root', eveToken);
    expect((await api('GET', `/search?q=kiwi&folder=${eveDir.id}`)).statusCode).toBe(404);
    expect((await api('GET', '/search?q=kiwi&folder=bogus')).statusCode).toBe(400);
  });

  it('recent: live files by mtime desc, limit', async () => {
    const files: SyncItem[] = [];
    for (let i = 0; i < 4; i++) files.push(await upload(`r${i}.txt`, `${i}`));
    await folder('NotAFile');
    // Give the files distinct mtimes (r2 newest) and re-index them.
    const base = Date.now() / 1000;
    for (const [i, age] of [[0, 300], [1, 200], [2, 10], [3, 100]] as const) {
      const abs = path.join(ctx.config.dataRoot, 'jens', `r${i}.txt`);
      await utimes(abs, base - age, base - age);
      const row = await ctx.prisma.item.findFirstOrThrow({ where: { name: `r${i}.txt` } });
      await ctx.prisma.item.update({ where: { id: row.id }, data: { mtime: new Date((base - age) * 1000) } });
    }
    const all = (await api('GET', '/recent')).json() as SyncItem[];
    expect(all.map((i) => i.name)).toEqual(['r2.txt', 'r3.txt', 'r1.txt', 'r0.txt']);
    expect((await api('GET', '/recent?limit=2')).json().map((i: SyncItem) => i.name)).toEqual(['r2.txt', 'r3.txt']);
  });

  describe('preview-text', () => {
    it('returns the UTF-8 text read from disk (fresh, not the extracted copy)', async () => {
      const f = await upload('readme.md', '# Hallo Welt – ünïcödé');
      await drain();
      const res = await api('GET', `/items/${f.id}/preview-text`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: '# Hallo Welt – ünïcödé', truncated: false, encoding: 'utf-8' });
      // An unindexed edit on the host shows up at once.
      await writeFile(path.join(ctx.config.dataRoot, 'jens', 'readme.md'), 'changed');
      expect((await api('GET', `/items/${f.id}/preview-text`)).json().text).toBe('changed');
    });

    it('latin1 fallback and code files', async () => {
      const f = await upload('legacy.txt', Buffer.from('Grüße', 'latin1'));
      expect((await api('GET', `/items/${f.id}/preview-text`)).json()).toEqual({ text: 'Grüße', truncated: false, encoding: 'latin1' });
      const ts = await upload('main.ts', await readFile(path.join(FIXTURES, 'sample.ts')));
      expect((await api('GET', `/items/${ts.id}/preview-text`)).statusCode).toBe(200);
    });

    it('truncates at 256 KiB', async () => {
      const exact = await upload('exact.txt', 'a'.repeat(256 * 1024));
      const over = await upload('over.log', 'b'.repeat(256 * 1024 + 1));
      const e = (await api('GET', `/items/${exact.id}/preview-text`)).json();
      expect(e.truncated).toBe(false);
      expect(e.text).toHaveLength(256 * 1024);
      const o = (await api('GET', `/items/${over.id}/preview-text`)).json();
      expect(o.truncated).toBe(true);
      expect(o.text).toHaveLength(256 * 1024);
    });

    it('415 for images/pdf/svg, 400 for folders', async () => {
      const png = await upload('pic.png', await readFile(path.join(FIXTURES, 'sample.png')));
      const svg = await upload('logo.svg', await readFile(path.join(FIXTURES, 'script.svg')));
      const pdf = await upload('doc.pdf', await readFile(path.join(FIXTURES, 'sample.pdf')));
      for (const f of [png, svg, pdf]) {
        const res = await api('GET', `/items/${f.id}/preview-text`);
        expect(res.statusCode).toBe(415);
        expect(res.json().code).toBe('invalid_request');
      }
      const dir = await folder('F');
      expect((await api('GET', `/items/${dir.id}/preview-text`)).statusCode).toBe(400);
    });
  });

  describe('spaces', () => {
    let team: { id: string }; let other: { id: string }; let bobToken: string;
    beforeEach(async () => {
      const jens = await ctx.prisma.user.findFirstOrThrow({ where: { username: 'jens' } });
      const bob = await createTestUser(ctx, 'bob');
      bobToken = await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: bob.id } }));
      team = await createTestSpace(ctx, 'Team');
      other = await createTestSpace(ctx, 'Other');
      await ctx.prisma.spaceMember.createMany({ data: [
        { spaceId: team.id, userId: jens.id, role: 'write' },
        { spaceId: team.id, userId: bob.id, role: 'read' },
        { spaceId: other.id, userId: jens.id, role: 'write' },
      ] });
    });

    it('finds team files for members (with spaceId and role capabilities), not for others', async () => {
      const docs = await folder('Docs', `r_${team.id}`);
      await upload('Budget team.txt', 'x', { parentId: docs.id });
      await upload('Budget mine.txt', 'x');
      await upload('Budget other.txt', 'x', { parentId: `r_${other.id}` });
      const mine = await search('Budget');
      expect(names(mine).sort()).toEqual(['Budget mine.txt', 'Budget other.txt', 'Budget team.txt']);
      const hit = mine.hits.find((h) => h.item.name === 'Budget team.txt')!;
      expect(hit).toMatchObject({ path: 'Docs', item: { spaceId: team.id, parentId: docs.id, capabilities: { write: true } } });
      expect(mine.hits.find((h) => h.item.name === 'Budget mine.txt')!.item.spaceId).toBe('personal');
      // bob (read member of Team): team hits only, read-only capabilities
      const bob = await search('Budget', '', bobToken);
      expect(names(bob)).toEqual(['Budget team.txt']);
      expect(bob.hits[0].item).toMatchObject({ spaceId: team.id, capabilities: { write: false, delete: false } });
      // eve (no membership): nothing
      expect(await search('Budget', '', eveToken)).toEqual({ hits: [], total: 0 });
    });

    it('space filter: personal, a team space, 404 without access; folder scope in a team space', async () => {
      const docs = await folder('Docs', `r_${team.id}`);
      await upload('Plan a.txt', 'x', { parentId: docs.id });
      await upload('Plan b.txt', 'x', { parentId: `r_${team.id}` });
      await upload('Plan c.txt', 'x');
      expect(names(await search('Plan', `&space=${team.id}`)).sort()).toEqual(['Plan a.txt', 'Plan b.txt']);
      expect(names(await search('Plan', '&space=personal'))).toEqual(['Plan c.txt']);
      expect(names(await search('Plan', `&folder=${docs.id}`))).toEqual(['Plan a.txt']);
      expect(names(await search('Plan', `&folder=r_${team.id}`)).sort()).toEqual(['Plan a.txt', 'Plan b.txt']);
      expect(names(await search('Plan', '&folder=root'))).toEqual(['Plan c.txt']);
      expect((await api('GET', `/search?q=Plan&space=${team.id}`, { as: eveToken })).statusCode).toBe(404);
      expect((await api('GET', `/search?q=Plan&folder=${docs.id}`, { as: eveToken })).statusCode).toBe(404);
      expect((await api('GET', '/search?q=Plan&space=nope')).statusCode).toBe(404);
      // a missing space answers 503 when asked for, and is skipped otherwise
      await ctx.prisma.space.update({ where: { id: team.id }, data: { status: 'missing' } });
      expect((await api('GET', `/search?q=Plan&space=${team.id}`)).json().code).toBe('space_unavailable');
      expect(names(await search('Plan'))).toEqual(['Plan c.txt']);
    });

    it('recent includes team files, honours the space filter and hides foreign spaces', async () => {
      await upload('old.txt', 'x');
      const t = await upload('team.txt', 'x', { parentId: `r_${team.id}` });
      const recent = (await api('GET', '/recent')).json() as SyncItem[];
      expect(recent.map((i) => i.name).sort()).toEqual(['old.txt', 'team.txt']);
      expect(recent.find((i) => i.name === 'team.txt')).toMatchObject({ id: t.id, spaceId: team.id });
      expect(recent.find((i) => i.name === 'old.txt')!.spaceId).toBe('personal');
      expect(((await api('GET', `/recent?space=${team.id}`)).json() as SyncItem[]).map((i) => i.name)).toEqual(['team.txt']);
      expect(((await api('GET', '/recent?space=personal')).json() as SyncItem[]).map((i) => i.name)).toEqual(['old.txt']);
      expect(((await api('GET', '/recent', { as: bobToken })).json() as SyncItem[]).map((i) => i.name)).toEqual(['team.txt']);
      expect((await api('GET', '/recent', { as: eveToken })).json()).toEqual([]);
      expect((await api('GET', `/recent?space=${team.id}`, { as: eveToken })).statusCode).toBe(404);
    });
  });

  it('an unknown SYNCLET_SEARCH_LANGUAGE falls back to simple; a known one is used as is', async () => {
    expect(await new SearchLanguage(ctx.prisma, { ...ctx.config, searchLanguage: "german'; DROP TABLE x; --" }).get()).toBe('simple');
    expect(await new SearchLanguage(ctx.prisma, { ...ctx.config, searchLanguage: 'German' }).get()).toBe('german');
  });
});
