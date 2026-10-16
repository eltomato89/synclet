import { Module, OnModuleInit } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { DerivativesModule } from '../derivatives/derivatives.module';
import { FilesModule } from '../files/files.module';
import { SyncErrorFilter } from '../common/sync-error';
import { DevicesController } from './devices.controller';
import { SerializerService } from './serializer.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [AuthModule, FilesModule, DerivativesModule],
  controllers: [SyncController, DevicesController],
  // SyncController is also a provider so DevicesController can reuse account().
  providers: [SerializerService, SyncController],
  exports: [SerializerService],
})
export class SyncModule implements OnModuleInit {
  constructor(private readonly serializer: SerializerService) {}

  onModuleInit() {
    SyncErrorFilter.serializeItem = async (row: Item) => {
      return (await this.serializer.toSyncItems({ id: row.spaceId }, [row]))[0];
    };
  }
}
