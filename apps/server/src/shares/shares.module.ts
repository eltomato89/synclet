import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { APP_CONFIG, AppConfig } from '../config';
import { DerivedStore } from '../derivatives/derived-store';
import { FilesModule } from '../files/files.module';
import { PublicSharesController } from './public-shares.controller';
import { ShareAuth, ShareRateLimits } from './share-auth';
import { ShareQuotas } from './share-quotas';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  imports: [AuthModule, FilesModule, JwtModule.register({})],
  controllers: [SharesController, PublicSharesController],
  providers: [
    SharesService, ShareAuth, ShareRateLimits, ShareQuotas,
    { provide: DerivedStore, useFactory: (config: AppConfig) => new DerivedStore(config.metaRoot), inject: [APP_CONFIG] },
  ],
})
export class SharesModule {}
