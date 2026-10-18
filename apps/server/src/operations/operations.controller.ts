import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { SyncOperation, ZipTicketResponse } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { ItemResolver } from '../sync/item-resolver';
import { CreateOperationBody, MAX_OPERATION_ITEMS, OperationsService, ResolveOperationBody } from './operations.service';
import { ZipTickets } from './zip-tickets';

const ZipBody = z.object({ itemIds: z.array(z.string()).min(1).max(MAX_OPERATION_ITEMS) });

/** Bulk copy / move / delete (SYNC_API §8.5). */
@Controller('sync/v1')
@UseGuards(AuthGuard)
export class OperationsController {
  constructor(
    private readonly ops: OperationsService,
    private readonly zipTickets: ZipTickets,
    private readonly resolver: ItemResolver,
  ) {}

  @Post('operations')
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateOperationBody)) body: z.infer<typeof CreateOperationBody>): Promise<SyncOperation> {
    return this.ops.create(user, body);
  }

  @Get('operations')
  list(@CurrentUser() user: AuthUser, @Query('active') active?: string): Promise<SyncOperation[]> {
    return this.ops.list(user, active === '1');
  }

  @Get('operations/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<SyncOperation> {
    return this.ops.get(user, id);
  }

  @Post('operations/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ResolveOperationBody)) body: z.infer<typeof ResolveOperationBody>): Promise<SyncOperation> {
    return this.ops.resolve(user, id, body);
  }

  @Post('operations/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<SyncOperation> {
    return this.ops.cancel(user, id);
  }

  /** A one-time URL for a ZIP of several files and folders (SYNC_API §6.5). */
  @Post('download-zip')
  @HttpCode(200)
  async downloadZip(@CurrentUser() user: AuthUser, @Body(new ZodPipe(ZipBody)) body: z.infer<typeof ZipBody>): Promise<ZipTicketResponse> {
    if (new Set(body.itemIds).size !== body.itemIds.length) throw new SyncError('invalid_request', 'duplicate item ids');
    for (const id of body.itemIds) {
      const r = await this.resolver.resolve(user, id, 'read');
      if (!r.item) throw new SyncError('invalid_request', 'a space root cannot be downloaded as ZIP');
    }
    const { token, expiresAt } = this.zipTickets.issue(user.id, body.itemIds);
    return { url: `/api/sync/v1/zip/${token}`, expiresAt: expiresAt.toISOString() };
  }
}
