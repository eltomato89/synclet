import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchLanguage } from '../search/search-language';

/** tsvector input cap for documents whose full text exceeds Postgres' 1 MB tsvector limit. */
const TSV_FALLBACK_CHARS = 256 * 1024;

/** Stores extracted text per content hash (`ItemText`) with its tsvector. */
@Injectable()
export class TextIndexer {
  private readonly log = new Logger(TextIndexer.name);

  constructor(private readonly prisma: PrismaService, private readonly lang: SearchLanguage) {}

  /** Upserts the text of `sha` (null removes it). */
  async store(sha: string, content: string | null): Promise<void> {
    if (content === null) {
      await this.prisma.itemText.deleteMany({ where: { sha } });
      return;
    }
    const lang = await this.lang.get();
    await this.prisma.itemText.upsert({ where: { sha }, create: { sha, content }, update: { content } });
    try {
      await this.updateTsv(sha, lang, null);
    } catch (e) {
      // "string is too long for tsvector": index a prefix (the stored content stays complete).
      if (!(e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) || !/too long for tsvector/i.test(e.message)) throw e;
      this.log.warn(`text of ${sha.slice(0, 12)} too large for a tsvector, indexing the first ${TSV_FALLBACK_CHARS} characters`);
      await this.updateTsv(sha, lang, TSV_FALLBACK_CHARS);
    }
  }

  private updateTsv(sha: string, lang: string, maxChars: number | null) {
    const source = maxChars === null ? Prisma.sql`content` : Prisma.sql`left(content, ${maxChars}::integer)`;
    return this.prisma.$executeRaw`
      UPDATE "ItemText" SET tsv = to_tsvector(${lang}::regconfig, synclet_unaccent(${source})) WHERE sha = ${sha}`;
  }
}
