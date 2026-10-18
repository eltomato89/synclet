import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { SyncOperation } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CreateOperationBody, OperationsService, ResolveOperationBody } from './operations.service';

/** Bulk copy / move / delete (SYNC_API §8.5). */
@Controller('sync/v1')
@UseGuards(AuthGuard)
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

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
}
