import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig } from './config';
import { CoreModule } from './core.module';
import { DerivativesModule } from './derivatives/derivatives.module';
import { HashBackfill } from './derivatives/hash';
import { JobsService } from './derivatives/jobs.service';
import { Thumbnailer } from './derivatives/thumbnails';
import { PrismaModule } from './prisma/prisma.module';
import { WorkerRunner } from './worker/worker-runner';

/** Module graph of the worker process: no HTTP, no journal, no indexer. */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(config), PrismaModule, DerivativesModule],
      providers: [JobsService, HashBackfill, Thumbnailer, WorkerRunner],
      exports: [WorkerRunner, JobsService, HashBackfill, Thumbnailer],
    };
  }
}
