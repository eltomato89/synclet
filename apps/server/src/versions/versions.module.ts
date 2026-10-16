import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SerializerService } from '../sync/serializer.service';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

/**
 * File versions. Imported by FilesModule (which re-exports it), so it must not import FilesModule
 * or SyncModule itself: restore reaches FilesService through `attachReplacer`, and the stateless
 * SerializerService is provided locally.
 */
@Module({
  imports: [AuthModule],
  controllers: [VersionsController],
  providers: [VersionsService, SerializerService],
  exports: [VersionsService],
})
export class VersionsModule {}
