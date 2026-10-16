import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import type { SsoSettingsWire } from '@synclet/shared';
import { z } from 'zod';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly, CurrentUser } from '../auth/current-user.decorator';
import { SsoSettingsInputParsed, SsoSettingsInputSchema, SsoSettingsService } from './sso-settings.service';

const TestBody = z.object({ issuer: z.string().trim().max(500).optional() }).strict().optional();

@Controller('admin/sso')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminSsoController {
  constructor(private readonly settings: SsoSettingsService) {}

  @Get()
  get(): Promise<SsoSettingsWire> {
    return this.settings.get();
  }

  @Put()
  update(@Body(new ZodPipe(SsoSettingsInputSchema)) body: SsoSettingsInputParsed, @CurrentUser() user: AuthUser): Promise<SsoSettingsWire> {
    return this.settings.update(body, user.id);
  }

  /** OIDC discovery check without saving (issuer from the body, else the saved one). */
  @Post('test')
  @HttpCode(200)
  test(@Body(new ZodPipe(TestBody)) body: z.infer<typeof TestBody>): Promise<{ ok: boolean; issuer?: string; error?: string }> {
    return this.settings.test(body?.issuer);
  }
}
