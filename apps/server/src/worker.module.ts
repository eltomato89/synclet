import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig } from './config';
import { CoreModule } from './core.module';
import { DerivativesModule } from './derivatives/derivatives.module';
import { HashBackfill } from './derivatives/hash';
import { JobsService } from './derivatives/jobs.service';
import { TextIndexer } from './derivatives/text-index';
import { Thumbnailer } from './derivatives/thumbnails';
import { SpacesModule } from './spaces/spaces.module';
import { PrismaModule } from './prisma/prisma.module';
import { SearchLanguage } from './search/search-language';
import { WorkerRunner } from './worker/worker-runner';

/** Module graph of the worker process: no HTTP, no journal, no indexer. */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(config), PrismaModule, SpacesModule, DerivativesModule],
      providers: [JobsService, HashBackfill, Thumbnailer, SearchLanguage, TextIndexer, WorkerRunner],
      exports: [WorkerRunner, JobsService, HashBackfill, Thumbnailer],
    };
  }
}
