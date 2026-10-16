import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ItemResolver } from '../sync/item-resolver';
import { SerializerService } from '../sync/serializer.service';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

/**
 * File versions. Imported by FilesModule (which re-exports it), so it must not import FilesModule
 * or SyncModule itself: restore reaches FilesService through `attachReplacer`, and the stateless
 * SerializerService and ItemResolver are provided locally.
 */
@Module({
  imports: [AuthModule],
  controllers: [VersionsController],
  providers: [VersionsService, SerializerService, ItemResolver],
  exports: [VersionsService],
})
export class VersionsModule {}
