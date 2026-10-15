import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig } from './config';
import { CoreModule } from './core.module';
import { PrismaModule } from './prisma/prisma.module';
import { WorkerRunner } from './worker/worker-runner';

/** Module graph of the worker process: no HTTP, no journal, no indexer. */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(config), PrismaModule],
      providers: [WorkerRunner],
      exports: [WorkerRunner],
    };
  }
}
