import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { SyncModule } from '../sync/sync.module';
import { OperationsController } from './operations.controller';
import { OperationsRunner } from './operations.runner';
import { OperationsService } from './operations.service';

/** Bulk operations of the web multi-select; the runner lives in the server process only. */
@Module({
  imports: [AuthModule, FilesModule, SyncModule],
  controllers: [OperationsController],
  providers: [OperationsService, OperationsRunner],
  exports: [OperationsService, OperationsRunner],
})
export class OperationsModule {}
