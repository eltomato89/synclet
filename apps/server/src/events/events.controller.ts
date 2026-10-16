import { Controller, Get, Inject, Logger, OnModuleDestroy, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimiter, RateLimits } from '../auth/rate-limit';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { JournalService } from '../journal/journal.service';
import { SpaceAccess } from '../spaces/space-access.service';
import { apiSpaceId, PERSONAL_API_ID } from '../spaces/space-ids';
import { ChangeNotifier } from './change-notifier';

/** Open streams per user; opening one more closes the oldest. */
export const MAX_STREAMS_PER_USER = 10;

interface Stream {
  userId: string;
  close(reason?: string): void;
}

@Controller('sync/v1')
export class EventsController implements OnModuleDestroy {
  private readonly log = new Logger(EventsController.name);
  /** Per user, oldest first. */
  private readonly streams = new Map<string, Stream[]>();
  /** Stream opens per user: 30 per minute. */
  readonly opens = new RateLimiter({ capacity: 30, refillPerSec: 0.5 });

  constructor(
    private readonly notifier: ChangeNotifier,
    private readonly journal: JournalService,
    private readonly access: SpaceAccess,
    private readonly guard: AuthGuard,
    private readonly limits: RateLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Server-Sent Events: a wake-up signal whenever the change journal of one of the user's readable
   * spaces advanced (`changes {space, cursor}`), and `account` when the user's space list or rights
   * changed. Clients always fetch the changes themselves with `GET /changes?space=` (SYNC_API.md "Events").
   */
  @Get('events')
  @UseGuards(AuthGuard)
  async events(@CurrentUser() user: AuthUser, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (!this.opens.take(user.id)) throw this.limits.limited(this.opens, user.id, reply);
    const authorization = req.headers.authorization;

    reply.hijack();
    const res: ServerResponse = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    let closed = false;
    /** Followed spaces (space id → API id and unsubscribe). */
    const followed = new Map<string, { apiId: string; unsubscribe: () => void }>();
    /** Per space: the cursor of the last `hello`/`changes` actually written to this stream. */
    const lastCursor = new Map<string, string>();
    const changesQueued = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    /**
     * Writes unless the client is not reading (socket buffer full): then the chunk is dropped.
     * Dropping is safe, `changes` is idempotent: the cursor is re-sent on `drain` or at the next
     * ping because `lastCursor` stays behind. `force` is for `hello`, `account` and the final `bye`.
     */
    const write = (chunk: string, force = false): boolean => {
      if (closed || res.writableEnded || res.destroyed) return false;
      if (res.writableNeedDrain && !force) return false;
      res.write(chunk);
      return true;
    };
    /** Runs stream work one at a time, so events never overtake each other. */
    const enqueue = (fn: () => Promise<void>) => {
      queue = queue.then(fn).catch((e: Error) => this.log.warn(`event stream: ${e.message}`));
    };
    /** Sends `changes` when the space's journal moved past the last cursor sent (reads the cursor). */
    const catchUp = async (spaceId: string) => {
      const f = followed.get(spaceId);
      if (!f) return; // no longer readable
      const cursor = await this.journal.currentCursor(spaceId);
      if (cursor === lastCursor.get(spaceId)) return; // e.g. a reconnect wake-up without news
      if (write(`event: changes\ndata: ${JSON.stringify({ space: f.apiId, cursor })}\n\n`)) lastCursor.set(spaceId, cursor);
    };
    const catchUpAll = async () => {
      for (const id of [...followed.keys()]) await catchUp(id);
    };
    const queueChanges = (spaceId: string) => {
      if (changesQueued.has(spaceId)) return; // the pending read will see the newest cursor anyway
      changesQueued.add(spaceId);
      enqueue(async () => {
        changesQueued.delete(spaceId);
        if (!closed) await catchUp(spaceId);
      });
    };
    /**
     * Follows exactly the spaces the user can read now: subscribes before any cursor is read, so no
     * commit in between is missed. Returns whether the set changed; newly followed spaces start at
     * their current cursor (the client learns about them from `/account`).
     */
    const follow = async (): Promise<boolean> => {
      const next = new Map((await this.access.spacesFor(user)).map(({ space }) => [space.id, apiSpaceId(space, user)]));
      if (closed) return false;
      let changed = false;
      for (const [id, f] of [...followed]) {
        if (next.get(id) === f.apiId) continue;
        f.unsubscribe();
        followed.delete(id);
        lastCursor.delete(id);
        changed = true;
      }
      const added: string[] = [];
      for (const [id, apiId] of next) {
        if (followed.has(id)) continue;
        followed.set(id, { apiId, unsubscribe: this.notifier.subscribe(id, () => queueChanges(id)) });
        added.push(id);
        changed = true;
      }
      for (const id of added) lastCursor.set(id, await this.journal.currentCursor(id));
      return changed;
    };
    /** The space list or rights changed: follow the new set, then tell the client to reload `/account`. */
    const accountChanged = async () => {
      if (closed) return;
      await follow();
      write('event: account\ndata: {}\n\n', true);
    };

    /** Notifications may have been lost: tell the client only if the space set really changed. */
    const resync = async () => {
      if (closed) return;
      if (await follow()) write('event: account\ndata: {}\n\n', true);
    };

    const unsubscribeAccount = this.notifier.subscribeAccount(user.id, () => enqueue(accountChanged), () => enqueue(resync));
    const ping = setInterval(() => enqueue(async () => {
      if (closed) return;
      try {
        // Device not revoked, user not disabled, access token still valid.
        const again = await this.guard.resolveFromHeaders({ headers: { authorization } });
        if (again.id !== user.id) throw new SyncError('unauthorized');
      } catch (e) {
        if (!(e instanceof SyncError)) throw e; // e.g. database briefly unavailable: keep the stream
        stream.close('unauthorized');
        return;
      }
      // Safety net: should the LISTEN connection be dead without anybody noticing (or never get
      // notifications, e.g. behind a transaction pooler), a change still arrives within one ping.
      await resync();
      await catchUpAll();
      write(': ping\n\n');
    }), this.config.eventsPingSeconds * 1000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribeAccount();
      for (const f of followed.values()) f.unsubscribe();
      followed.clear();
      const list = (this.streams.get(user.id) ?? []).filter((s) => s !== stream);
      if (list.length) this.streams.set(user.id, list);
      else this.streams.delete(user.id);
    };
    const stream: Stream = {
      userId: user.id,
      close: (reason) => {
        if (reason) write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`, true);
        cleanup();
        res.end();
      },
    };
    // Client disconnect (both fire when the socket goes away; the response's also after `end()`).
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    res.on('drain', () => { for (const id of followed.keys()) queueChanges(id); });

    if (this.shuttingDown) {
      stream.close('server_shutdown');
      return;
    }
    const list = this.streams.get(user.id) ?? [];
    while (list.length >= MAX_STREAMS_PER_USER) list.shift()!.close('too_many_streams');
    list.push(stream);
    this.streams.set(user.id, list);

    enqueue(async () => {
      if (closed) return;
      await follow();
      if (closed) return;
      // `cursor` stays the personal one (old clients); `cursors` has every followed space.
      const cursors: Record<string, string> = {};
      for (const [id, f] of followed) cursors[f.apiId] = lastCursor.get(id) ?? (await this.journal.currentCursor(id));
      const cursor = cursors[PERSONAL_API_ID] ?? (await this.journal.currentCursor(user.id));
      write(`event: hello\ndata: ${JSON.stringify({ cursor, cursors })}\n\n`, true);
    });
  }

  private shuttingDown = false;

  /**
   * Ends every open stream on shutdown (otherwise the HTTP server waits for them). Streams opened
   * after this, before the HTTP server stops accepting, are closed right away.
   */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const list of [...this.streams.values()]) for (const s of [...list]) s.close('server_shutdown');
  }
}
