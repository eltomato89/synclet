import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndexerModule } from '../indexer/indexer.module';
import { SharesModule } from '../shares/shares.module';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminSharesController } from './admin-shares.controller';
import { AdminStatusController } from './admin-status.controller';
import { AdminStatusService } from './admin-status.service';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [AuthModule, SharesModule, IndexerModule],
  controllers: [AdminUsersController, AdminSessionsController, AdminSharesController, AdminStatusController],
  providers: [AdminStatusService],
})
export class AdminModule {}
