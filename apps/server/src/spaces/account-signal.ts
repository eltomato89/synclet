import { Injectable, Logger } from '@nestjs/common';
import { ACCOUNT_CHANNEL } from '../events/change-notifier';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Tells the event streams of these users that their space list or rights changed (SSE `account`).
 * Sends `pg_notify('synclet_account', userId)` directly, so it works from any process (API server,
 * scheduler, worker); the API process's ChangeNotifier listens on that channel. Collect the users
 * *before* a change that drops memberships and pass before ∪ after.
 */
@Injectable()
export class AccountSignal {
  private readonly log = new Logger(AccountSignal.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best effort: a failed notification is logged; open streams still notice a changed space set at their next ping. */
  async notify(userIds: Iterable<string>): Promise<void> {
    for (const id of new Set(userIds)) {
      await this.prisma.$executeRaw`SELECT pg_notify(${ACCOUNT_CHANNEL}, ${id})`.catch((e: Error) => this.log.warn(`account notification for ${id} failed: ${e.message}`));
    }
  }
}
