import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from './config';
import { AppEvents } from './common/events';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JournalModule } from './journal/journal.module';
import { IndexerModule } from './indexer/indexer.module';
import { FilesModule } from './files/files.module';
import { SyncModule } from './sync/sync.module';
import { HealthController } from './health.controller';

@Global()
@Module({})
class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: APP_CONFIG, useValue: config }, AppEvents],
      exports: [APP_CONFIG, AppEvents],
    };
  }
}

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
