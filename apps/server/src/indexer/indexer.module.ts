import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { UploadsModule } from '../uploads/uploads.module';
import { IndexerService } from './indexer.service';
import { SchedulerService } from './scheduler.service';
import { StatusController } from './status.controller';
import { WatcherService } from './watcher.service';

@Module({
  imports: [AuthModule, FilesModule, UploadsModule],
  controllers: [StatusController],
  providers: [IndexerService, WatcherService, SchedulerService],
  exports: [IndexerService],
})
export class IndexerModule {}
