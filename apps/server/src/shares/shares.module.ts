import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { DerivativesModule } from '../derivatives/derivatives.module';
import { FilesModule } from '../files/files.module';
import { PublicSharesController } from './public-shares.controller';
import { ShareAuth, ShareRateLimits } from './share-auth';
import { ShareQuotas } from './share-quotas';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  imports: [AuthModule, FilesModule, DerivativesModule, JwtModule.register({})],
  controllers: [SharesController, PublicSharesController],
  providers: [
    SharesService, ShareAuth, ShareRateLimits, ShareQuotas,
  ],
  exports: [SharesService],
})
export class SharesModule {}
