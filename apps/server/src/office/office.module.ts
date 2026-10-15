import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { SyncModule } from '../sync/sync.module';
import { OfficePublicController } from './office-public.controller';
import { OfficeController } from './office.controller';
import { OfficeService } from './office.service';

@Module({
  imports: [AuthModule, FilesModule, SyncModule],
  controllers: [OfficeController, OfficePublicController],
  providers: [OfficeService],
  exports: [OfficeService],
})
export class OfficeModule {}
