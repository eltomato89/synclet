import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DerivativesModule } from '../derivatives/derivatives.module';
import { FilesModule } from '../files/files.module';
import { TrashModule } from '../trash/trash.module';
import { UploadsModule } from '../uploads/uploads.module';
import { IndexerService } from './indexer.service';
import { SchedulerService } from './scheduler.service';
import { WatcherService } from './watcher.service';

@Module({
  imports: [AuthModule, FilesModule, TrashModule, UploadsModule, DerivativesModule],
  providers: [IndexerService, WatcherService, SchedulerService],
  exports: [IndexerService, WatcherService, SchedulerService],
})
export class IndexerModule {}
