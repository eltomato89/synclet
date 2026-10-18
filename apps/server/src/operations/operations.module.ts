import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { IndexerModule } from '../indexer/indexer.module';
import { SyncModule } from '../sync/sync.module';
import { OperationsController } from './operations.controller';
import { OperationsRunner } from './operations.runner';
import { OperationsService } from './operations.service';
import { ZipController } from './zip.controller';
import { ZipTickets } from './zip-tickets';

/** Bulk operations of the web multi-select; the runner lives in the server process only. */
@Module({
  imports: [AuthModule, FilesModule, IndexerModule, SyncModule],
  controllers: [OperationsController, ZipController],
  providers: [OperationsService, OperationsRunner, ZipTickets],
  exports: [OperationsService, OperationsRunner],
})
export class OperationsModule {}
