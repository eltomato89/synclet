import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { AdminSsoController } from './admin-sso.controller';
import { ForwardAuthService } from './forward-auth.service';
import { OidcService } from './oidc.service';
import { ProvisioningService } from './provisioning.service';
import { SsoController } from './sso.controller';

/** OIDC + forward-auth login and the admin SSO settings API. `SsoSettingsService` lives in AuthModule (password login rule). */
@Module({
  imports: [AuthModule, JwtModule.register({})],
  controllers: [SsoController, AdminSsoController],
  providers: [OidcService, ForwardAuthService, ProvisioningService],
  exports: [ProvisioningService],
})
export class SsoModule {}
