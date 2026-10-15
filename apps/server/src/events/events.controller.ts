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
    private readonly guard: AuthGuard,
    private readonly limits: RateLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Server-Sent Events: a wake-up signal whenever the user's change journal advanced. Clients
   * always fetch the changes themselves with `GET /changes` (SYNC_API.md "Events").
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
    let lastCursor: string | null = null;
    let queue: Promise<void> = Promise.resolve();
    const write = (chunk: string) => {
      if (!closed && !res.writableEnded && !res.destroyed) res.write(chunk);
    };
    /** Runs stream work one at a time, so events never overtake each other. */
    const enqueue = (fn: () => Promise<void>) => {
      queue = queue.then(fn).catch((e: Error) => this.log.warn(`event stream: ${e.message}`));
    };
    const sendCursor = (event: 'hello' | 'changes') => enqueue(async () => {
      if (closed) return;
      const cursor = await this.journal.currentCursor(user.id);
      if (event === 'changes' && cursor === lastCursor) return; // e.g. a reconnect wake-up without news
      lastCursor = cursor;
      write(event === 'hello'
        ? `event: hello\ndata: ${JSON.stringify({ cursor })}\n\n`
        : `event: changes\ndata: ${JSON.stringify({ space: 'personal', cursor })}\n\n`);
    });

    // Subscribe before reading the hello cursor, so no commit between the two is missed.
    const unsubscribe = this.notifier.subscribe(user.id, () => sendCursor('changes'));
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
      write(': ping\n\n');
    }), this.config.eventsPingSeconds * 1000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      const list = (this.streams.get(user.id) ?? []).filter((s) => s !== stream);
      if (list.length) this.streams.set(user.id, list);
      else this.streams.delete(user.id);
    };
    const stream: Stream = {
      userId: user.id,
      close: (reason) => {
        if (reason) write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
        cleanup();
        res.end();
      },
    };
    // Client disconnect (both fire when the socket goes away; the response's also after `end()`).
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    const list = this.streams.get(user.id) ?? [];
    while (list.length >= MAX_STREAMS_PER_USER) list.shift()!.close('too_many_streams');
    list.push(stream);
    this.streams.set(user.id, list);

    sendCursor('hello');
  }

  /** Ends every open stream on shutdown (otherwise the HTTP server waits for them). */
  onModuleDestroy(): void {
    for (const list of [...this.streams.values()]) for (const s of [...list]) s.close();
  }
}
