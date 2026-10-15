import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The text search configuration (`SYNCLET_SEARCH_LANGUAGE`) checked against `pg_ts_config` once
 * at startup; an unknown name falls back to `simple` with a warning. The value is only ever
 * passed as a bind parameter (`$1::regconfig`), never interpolated into SQL.
 */
@Injectable()
export class SearchLanguage implements OnModuleInit {
  private readonly log = new Logger(SearchLanguage.name);
  private resolved: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.get();
  }

  /** The validated configuration name. */
  get(): Promise<string> {
    this.resolved ??= this.resolve().catch((e: unknown) => {
      this.resolved = null; // DB not reachable yet: try again on the next call
      throw e;
    });
    return this.resolved;
  }

  private async resolve(): Promise<string> {
    const wanted = this.config.searchLanguage.trim().toLowerCase();
    const rows = await this.prisma.$queryRaw<{ cfgname: string }[]>`SELECT cfgname FROM pg_ts_config WHERE cfgname = ${wanted} AND pg_ts_config_is_visible(oid)`;
    if (rows.length) return rows[0].cfgname;
    this.log.warn(`unknown SYNCLET_SEARCH_LANGUAGE "${this.config.searchLanguage}", using "simple"`);
    return 'simple';
  }
}
