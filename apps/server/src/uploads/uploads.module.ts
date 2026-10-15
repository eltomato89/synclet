import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { SyncModule } from '../sync/sync.module';
import { TusService } from './tus';

@Module({
  imports: [AuthModule, FilesModule, SyncModule],
  providers: [TusService],
  exports: [TusService],
})
export class UploadsModule {}
