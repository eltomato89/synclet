import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { freeName, nameKey } from '../common/names';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { PrismaService } from '../prisma/prisma.service';
import { createZip, type ZipEntrySource, zipEntryName } from '../shares/zip';
import { attachmentDisposition, openNoFollow } from '../sync/http-content';
import { ItemResolver } from '../sync/item-resolver';
import { ZipTickets } from './zip-tickets';

/**
 * Redeems a ZIP ticket. No AuthGuard: the one-time ticket from POST /download-zip is the
 * credential; access to every item is checked again for the ticket's user, items without access
 * (any more) are left out, none left → 404.
 */
@Controller('sync/v1/zip')
export class ZipController {
  private readonly log = new Logger(ZipController.name);

  constructor(
    private readonly tickets: ZipTickets,
    private readonly resolver: ItemResolver,
    private readonly files: FilesService,
    private readonly store: ItemStore,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':ticket')
  async zip(@Param('ticket') ticket: string, @Res() reply: FastifyReply) {
    const t = this.tickets.take(ticket);
    if (!t) throw new SyncError('not_found');
    const tops: { space: IndexSpace; item: Item }[] = [];
    for (const id of t.itemIds) {
      const r = await this.resolver.resolve({ id: t.userId }, id, 'read').catch(() => null);
      if (r?.item) tops.push({ space: r.space, item: r.item });
    }
    if (tops.length === 0) throw new SyncError('not_found');
    const entries: ZipEntrySource[] = [];
    const used = new Set<string>();
    for (const { space, item } of tops) {
      const top = freeName(item.name, used, item.type === 'folder');
      used.add(nameKey(top));
      entries.push(this.entry(space, item, zipEntryName(top)));
      if (item.type !== 'folder') continue;
      const rows = (await this.store.liveDescendants(this.prisma, space.id, item.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const r of rows) entries.push(this.entry(space, r, zipEntryName(`${top}/${r.path.slice(item.path.length + 1)}`)));
    }
    const name = tops.length === 1 && tops[0].item.type === 'folder' ? `${tops[0].item.name}.zip` : `Synclet-${new Date().toISOString().slice(0, 10)}.zip`;
    const zip = createZip(entries, this.log);
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) zip.abort(); });
    return reply
      .header('Content-Type', 'application/zip').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', attachmentDisposition(name))
      .send(zip.stream);
  }

  private entry(space: IndexSpace, row: Item, name: string): ZipEntrySource {
    return {
      name, type: row.type, mtime: row.mtime,
      open: row.type === 'file'
        ? async (): Promise<Readable | null> => {
          const { abs } = await this.files.openRead(space, row.id); // realpath inside the space root
          return (await openNoFollow(abs)).createReadStream();
        }
        : undefined,
    };
  }
}
