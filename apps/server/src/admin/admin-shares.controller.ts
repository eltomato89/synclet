import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import type { AdminShareWire } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly, CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { SharesService } from '../shares/shares.service';
import { UUID } from '../sync/sync-ids';

const Query_ = z.object({
  userId: z.string().regex(UUID).optional(),
  /** Space uuid: only links into that space. */
  spaceId: z.string().regex(UUID).optional(),
  status: z.enum(['active', 'expired', 'all']).default('active'),
});

@Controller('admin/shares')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminSharesController {
  constructor(private readonly shares: SharesService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>): Promise<AdminShareWire[]> {
    return this.shares.listForAdmin(me, q);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string): Promise<void> {
    await this.shares.revokeAny(id);
  }
}
