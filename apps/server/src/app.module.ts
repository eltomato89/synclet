import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig } from './config';
import { CoreModule } from './core.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JournalModule } from './journal/journal.module';
import { IndexerModule } from './indexer/indexer.module';
import { FilesModule } from './files/files.module';
import { SyncModule } from './sync/sync.module';
import { HealthController } from './health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config), PrismaModule, AuthModule, JournalModule, IndexerModule, FilesModule, SyncModule],
      controllers: [HealthController],
    };
  }
}
