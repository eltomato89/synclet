import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminUsersController } from './admin-users.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { DevicesService } from './devices.service';
import { ServerConfigService } from './server-config.service';
import { SetupController } from './setup.controller';
import { UsersService } from './users.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [SetupController, AuthController, AdminUsersController],
  providers: [AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService],
  exports: [AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService],
})
export class AuthModule {}
