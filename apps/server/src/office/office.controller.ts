import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { OfficeEditorConfig, SyncItem } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { SerializerService } from '../sync/serializer.service';
import { parseSyncId } from '../sync/sync-ids';
import { NEW_FORMATS, OfficeService } from './office.service';

const NewOfficeBody = z.object({
  parentId: z.string(),
  name: z.string().max(1024),
  format: z.enum(NEW_FORMATS as [string, ...string[]]),
});

/** Office routes for signed-in users (editor config, new documents from templates). */
@Controller('sync/v1')
@UseGuards(AuthGuard)
export class OfficeController {
  constructor(
    private readonly office: OfficeService,
    private readonly files: FilesService,
    private readonly prisma: PrismaService,
    private readonly serializer: SerializerService,
    private readonly spaces: SpacesRepo,
  ) {}

  /** Signed Document Server config for opening file `id` in the office editor. */
  @Get('items/:id/office')
  async editorConfig(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('lang') lang?: string): Promise<OfficeEditorConfig> {
    this.office.assertEnabled();
    const parsed = parseSyncId(id);
    if (!parsed || parsed.kind === 'root') throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const space = await this.spaces.personalFor(user.id);
    const item = await this.prisma.item.findFirst({ where: { id: parsed.uuid, spaceId: space.id, deletedAt: null, type: 'file' } });
    if (!item) throw new SyncError('not_found');
    return this.office.editorConfig(user, item, lang);
  }

  /** New empty document from a template; a taken name gets a free suffix. Works without a Document Server. */
  @Post('items/new-office')
  @HttpCode(201)
  async createNew(@CurrentUser() user: AuthUser, @Body(new ZodPipe(NewOfficeBody)) body: z.infer<typeof NewOfficeBody>): Promise<SyncItem> {
    const format = body.format as (typeof NEW_FORMATS)[number];
    const parsed = parseSyncId(body.parentId);
    if (!parsed) throw new SyncError('invalid_request', 'invalid parentId');
    if (parsed.kind === 'file') throw new SyncError('invalid_request', 'parent is not a folder');
    const parentId = parsed.kind === 'root' ? null : parsed.uuid;
    const space = await this.spaces.personalFor(user.id);
    const row = await this.files.createFromTemplate(space, parentId, OfficeService.newFileName(body.name, format), this.office.templatePath(format));
    return (await this.serializer.toSyncItems(space, [row]))[0];
  }
}
