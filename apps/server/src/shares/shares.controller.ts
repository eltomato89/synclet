import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { ShareLinkWire } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { SharesService } from './shares.service';

const Password = z.string().min(1).max(1024);
const Expiry = z.string().datetime({ offset: true });

const CreateBody = z.object({
  itemId: z.string(),
  password: Password.nullable().optional(),
  expiresAt: Expiry.nullable().optional(),
  allowDownload: z.boolean().optional(),
  allowUpload: z.boolean().optional(),
}).strict();

const PatchBody = z.object({
  password: Password.nullable().optional(),
  expiresAt: Expiry.nullable().optional(),
  allowDownload: z.boolean().optional(),
  allowUpload: z.boolean().optional(),
}).strict();

/** Share links of the signed-in user. */
@Controller('shares')
@UseGuards(AuthGuard)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<ShareLinkWire> {
    return this.shares.create(user, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('itemId') itemId?: string): Promise<ShareLinkWire[]> {
    return this.shares.list(user, itemId);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ShareLinkWire> {
    return this.shares.rotate(user, id);
  }

  @Patch(':id')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>): Promise<ShareLinkWire> {
    return this.shares.patch(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.shares.revoke(user, id);
  }
}
