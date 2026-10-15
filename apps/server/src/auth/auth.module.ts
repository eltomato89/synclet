import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminUsersController } from './admin-users.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { DevicesService } from './devices.service';
import { RateLimits } from './rate-limit';
import { ServerConfigService } from './server-config.service';
import { SetupController } from './setup.controller';
import { UsersService } from './users.service';
import { SsoSettingsService } from '../sso/sso-settings.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [SetupController, AuthController, AdminUsersController],
  providers: [RateLimits, AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService, SsoSettingsService],
  exports: [RateLimits, AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService, SsoSettingsService],
})
export class AuthModule {}
