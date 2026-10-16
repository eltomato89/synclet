import { Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { SyncItem, VersionWire } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import type { Role } from '../spaces/space-access.service';
import { sendFile } from '../sync/http-content';
import { ItemResolver, type Resolved } from '../sync/item-resolver';
import { SerializerService } from '../sync/serializer.service';
import { parseSyncId } from '../sync/sync-ids';
import { VersionsService } from './versions.service';

/** Versions live in every space (`<meta>/versions/<spaceId>/…`): listing and download need read, restore needs write. */
@Controller('sync/v1/items/:id/versions')
@UseGuards(AuthGuard)
export class VersionsController {
  constructor(private readonly versions: VersionsService, private readonly serializer: SerializerService, private readonly resolver: ItemResolver) {}

  /** The live file behind a sync id (`f_<uuid>`) with the caller's access to its space; anything else is not a file with versions. */
  private async file(user: AuthUser, raw: string, need: Role): Promise<Resolved & { itemId: string }> {
    const parsed = parseSyncId(raw);
    if (!parsed) throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const r = await this.resolver.resolve(user, raw, need);
    // A download token minted for another space (the item was moved since) is not valid here.
    if (user.downloadSpace !== undefined && user.downloadSpace !== r.space.id) throw new SyncError('not_found');
    return { ...r, itemId: parsed.uuid };
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<VersionWire[]> {
    const { space, itemId } = await this.file(user, id, 'read');
    return this.versions.list(space, itemId);
  }

  /** Always an attachment named `<base> (v<n>).<ext>`; accepts the item's download token (`?dt=`). */
  @Get(':versionId/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('versionId') versionId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const { space, itemId } = await this.file(user, id, 'read');
    const { item, version, abs, downloadName } = await this.versions.openRead(space, itemId, versionId);
    // ETag `v<n>`: the content version these bytes had while current. Rows of the store carry no inode.
    const asItem = { ...item, name: downloadName, version: version.version, size: version.size, mtime: version.mtime, ino: null, dev: null };
    return sendFile(req, reply, asItem, abs, { download: true });
  }

  @Post(':versionId/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('versionId') versionId: string): Promise<SyncItem> {
    const { space, itemId, view } = await this.file(user, id, 'write');
    const row = await this.versions.restore(space, itemId, versionId, user.id);
    return (await this.serializer.toSyncItems(space, [row], view))[0];
  }
}
