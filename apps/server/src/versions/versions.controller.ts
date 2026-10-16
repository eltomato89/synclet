import { Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { SyncItem, VersionWire } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { sendFile } from '../sync/http-content';
import { SerializerService } from '../sync/serializer.service';
import { parseSyncId } from '../sync/sync-ids';
import { SpacesRepo } from '../spaces/spaces.repo';
import { VersionsService } from './versions.service';

/** File id of a sync id (`f_<uuid>`); anything else is not a file with versions. */
function fileId(raw: string): string {
  const parsed = parseSyncId(raw);
  if (!parsed) throw new SyncError('invalid_request', 'invalid id');
  if (parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
  return parsed.uuid;
}

@Controller('sync/v1/items/:id/versions')
@UseGuards(AuthGuard)
export class VersionsController {
  constructor(private readonly versions: VersionsService, private readonly serializer: SerializerService, private readonly spaces: SpacesRepo) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<VersionWire[]> {
    const itemId = fileId(id);
    return this.versions.list(await this.spaces.personalFor(user.id), itemId);
  }

  /** Always an attachment named `<base> (v<n>).<ext>`; accepts the item's download token (`?dt=`). */
  @Get(':versionId/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('versionId') versionId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const itemId = fileId(id);
    const { item, version, abs, downloadName } = await this.versions.openRead(await this.spaces.personalFor(user.id), itemId, versionId);
    // ETag `v<n>`: the content version these bytes had while current. Rows of the store carry no inode.
    const asItem = { ...item, name: downloadName, version: version.version, size: version.size, mtime: version.mtime, ino: null, dev: null };
    return sendFile(req, reply, asItem, abs, { download: true });
  }

  @Post(':versionId/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('versionId') versionId: string): Promise<SyncItem> {
    const itemId = fileId(id);
    const space = await this.spaces.personalFor(user.id);
    const row = await this.versions.restore(space, itemId, versionId, user.id);
    return (await this.serializer.toSyncItems(space, [row]))[0];
  }
}
