import { Module, OnModuleInit } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { DerivativesModule } from '../derivatives/derivatives.module';
import { FilesModule } from '../files/files.module';
import { SyncErrorFilter } from '../common/sync-error';
import { DevicesController } from './devices.controller';
import { ItemResolver } from './item-resolver';
import { SerializerService } from './serializer.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [AuthModule, FilesModule, DerivativesModule],
  controllers: [SyncController, DevicesController],
  // SyncController is also a provider so DevicesController can reuse account().
  providers: [SerializerService, SyncController, ItemResolver],
  exports: [SerializerService, ItemResolver],
})
export class SyncModule implements OnModuleInit {
  constructor(private readonly serializer: SerializerService) {}

  onModuleInit() {
    SyncErrorFilter.serializeItem = async (row: Item, user?: { id: string }) => {
      const view = user ? await this.serializer.viewFor(user, row.spaceId) : undefined;
      return (await this.serializer.toSyncItems({ id: row.spaceId }, [row], view))[0];
    };
  }
}
