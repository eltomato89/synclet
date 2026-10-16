import { Injectable } from '@nestjs/common';
import { Item, Prisma } from '@prisma/client';
import type { SearchHit, SearchResponse, SyncItem } from '@synclet/shared';
import { parentRel } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SerializerService, type ItemView } from '../sync/serializer.service';
import { SearchLanguage } from './search-language';

export const MAX_QUERY_CHARS = 200;
/**
 * Threshold for the word-similarity operator `<%` (query vs. the best-matching part of a name).
 * Plain `%` compares the query with the whole name, which a file extension or a second word
 * dilutes below the default 0.3 ("Rechnnug" vs "Rechnung.pdf" = 0.29); word similarity at 0.5
 * still finds such typos without matching unrelated names.
 */
const WORD_SIMILARITY = '0.5';
/** ts_headline parses its whole input: only the start of large documents is used for snippets. */
const HEADLINE_INPUT_CHARS = 65_536;
/** Snippets are cut to this length (a run of text without spaces can make a fragment long). */
export const MAX_SNIPPET_CHARS = 300;
const HEADLINE_OPTS = 'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=18,MinWords=6';

/** LIKE pattern for a literal substring (backslash is LIKE's default escape character). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Cuts a snippet to MAX_SNIPPET_CHARS (plus an ellipsis), closing a highlight cut in half. */
export function capSnippet(s: string): string {
  const chars = [...s];
  if (chars.length <= MAX_SNIPPET_CHARS) return s;
  let out = chars.slice(0, MAX_SNIPPET_CHARS).join('');
  if (out.lastIndexOf('«') > out.lastIndexOf('»')) out += '»';
  return `${out}…`;
}

/** A space searched for the caller, with the caller's view on it (API id, role). */
export interface SearchSpace { space: IndexSpace; view: ItemView }

interface HitRow { id: string | null; name_score: number | null; content_score: number | null; total: bigint; snippet: string | null }

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serializer: SerializerService,
    private readonly lang: SearchLanguage,
  ) {}

  /**
   * Name (trigram, accent- and case-insensitive) and content (full text over ItemText) search
   * across the live items of `spaces` (the caller's readable spaces, or one of them). Every branch
   * filters `spaceId` and `deletedAt IS NULL` on the Item row itself – ItemText is shared by
   * content hash across spaces and never returned alone. `folderPath` restricts to a subtree (its path
   * in the single space searched).
   *
   * The name predicates use exactly the expression of `Item_name_trgm_idx`
   * (`synclet_unaccent(lower(name))`, partial on `"deletedAt" IS NULL`) so the index applies.
   */
  async search(spaces: SearchSpace[], rawQ: string, opts: { limit: number; offset: number; folderPath?: string }): Promise<SearchResponse> {
    const q = (rawQ ?? '').trim();
    if (q.length < 1 || q.length > MAX_QUERY_CHARS) throw new SyncError('invalid_request', `q must be 1..${MAX_QUERY_CHARS} characters`);
    if (spaces.length === 0) return { hits: [], total: 0 };
    const ids = spaces.map((s) => s.space.id);
    const inSpaces = Prisma.sql`i."spaceId" = ANY(${ids}::uuid[])`;
    const scope = opts.folderPath ? Prisma.sql`AND i.path LIKE ${`${escapeLike(opts.folderPath)}/%`}` : Prisma.empty;
    const lang = await this.lang.get();
    const nameExpr = Prisma.sql`synclet_unaccent(lower(i.name))`;
    const nq = Prisma.sql`synclet_unaccent(lower(${q}))`;
    // Substring match on the normalized name; the normalized query is escaped for LIKE afterwards.
    const like = Prisma.sql`'%' || replace(replace(replace(${nq}, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;
    const tsq = Prisma.sql`websearch_to_tsquery(${lang}::regconfig, synclet_unaccent(${q}))`;
    // ts_headline matches against the original (accented) content: the query is offered both as
    // typed and unaccented, so a word is highlighted whenever one of the two spellings occurs.
    const headlineQ = Prisma.sql`(websearch_to_tsquery(${lang}::regconfig, ${q}) || ${tsq})`;

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${WORD_SIMILARITY}, true)`;
      return tx.$queryRaw<HitRow[]>`
        WITH name_hits AS (
          SELECT i.id, GREATEST(similarity(${nameExpr}, ${nq}), word_similarity(${nq}, ${nameExpr})) AS score
          FROM "Item" i
          WHERE ${inSpaces} AND i."deletedAt" IS NULL ${scope}
            AND (${nameExpr} % ${nq} OR ${nq} <% ${nameExpr} OR ${nameExpr} LIKE ${like})
        ),
        content_hits AS (
          SELECT i.id, ts_rank(t.tsv, ${tsq}) AS score
          FROM "ItemText" t
          JOIN "Item" i ON i."contentHash" = t.sha
          WHERE t.tsv @@ ${tsq}
            AND ${inSpaces} AND i."deletedAt" IS NULL AND i.type = 'file' ${scope}
        ),
        hits AS (
          SELECT coalesce(n.id, c.id) AS id, n.score AS name_score, c.score AS content_score,
                 coalesce(n.score, 0) * 2 + coalesce(c.score, 0) AS rank
          FROM name_hits n FULL JOIN content_hits c ON c.id = n.id
        ),
        page AS (
          SELECT h.* FROM hits h ORDER BY h.rank DESC, h.id LIMIT ${opts.limit} OFFSET ${opts.offset}
        )
        -- One row even for an empty page, so the total is always known.
        SELECT p.id, p.name_score::float8 AS name_score, p.content_score::float8 AS content_score, c.total,
          CASE WHEN p.content_score IS NULL THEN NULL
               ELSE ts_headline(${lang}::regconfig, left(t.content, ${HEADLINE_INPUT_CHARS}::integer), ${headlineQ}, ${HEADLINE_OPTS}) END AS snippet
        FROM (SELECT count(*) AS total FROM hits) c
        LEFT JOIN page p ON true
        LEFT JOIN "Item" i ON i.id = p.id
        LEFT JOIN "ItemText" t ON p.content_score IS NOT NULL AND t.sha = i."contentHash"
        ORDER BY p.rank DESC, p.id`;
    }, { timeout: 15_000 });

    const total = Number(rows[0]?.total ?? 0);
    const pageRows = rows.filter((r): r is HitRow & { id: string } => r.id !== null);
    const items = await this.prisma.item.findMany({ where: { id: { in: pageRows.map((r) => r.id) }, spaceId: { in: ids }, deletedAt: null } });
    const byId = new Map(items.map((r) => [r.id, r]));
    const ordered = pageRows.flatMap((r) => (byId.has(r.id) ? [{ row: byId.get(r.id)!, hit: r }] : []));
    const serialized = await this.serializeAcross(spaces, ordered.map((o) => o.row));
    const hits: SearchHit[] = ordered.map(({ row, hit }, i) => this.hit(row, serialized[i], hit));
    return { hits, total };
  }

  private hit(row: Item, item: SyncItem, h: HitRow): SearchHit {
    const matched = h.name_score !== null && h.content_score !== null ? 'both' : h.name_score !== null ? 'name' : 'content';
    return { item, path: parentRel(row.path), snippet: h.snippet === null ? null : capSnippet(h.snippet), matched };
  }

  /** Serializes rows of several spaces (each with the caller's view), keeping their order. */
  async serializeAcross(spaces: SearchSpace[], rows: Item[]): Promise<SyncItem[]> {
    const bySpace = new Map(spaces.map((s) => [s.space.id, s]));
    const out = new Map<string, SyncItem>();
    for (const s of spaces) {
      const mine = rows.filter((r) => r.spaceId === s.space.id);
      const items = await this.serializer.toSyncItems(s.space, mine, s.view);
      mine.forEach((r, i) => out.set(r.id, items[i]));
    }
    return rows.filter((r) => bySpace.has(r.spaceId)).map((r) => out.get(r.id)!);
  }
}
