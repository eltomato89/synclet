import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndexerModule } from '../indexer/indexer.module';
import { SharesModule } from '../shares/shares.module';
import { AdminGroupsController } from './admin-groups.controller';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminSharesController } from './admin-shares.controller';
import { AdminSpacesController } from './admin-spaces.controller';
import { AdminStatusController } from './admin-status.controller';
import { AdminStatusService } from './admin-status.service';
import { AdminUsersController } from './admin-users.controller';
import { UpdateCheckService } from './update-check.service';

@Module({
  imports: [AuthModule, SharesModule, IndexerModule],
  controllers: [
    AdminUsersController, AdminSessionsController, AdminSharesController, AdminStatusController,
    AdminGroupsController, AdminSpacesController,
  ],
  providers: [AdminStatusService, UpdateCheckService],
})
export class AdminModule {}
