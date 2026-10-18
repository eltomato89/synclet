import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

export const ZIP_TICKET_TTL_MS = 120_000;

interface Ticket { userId: string; itemIds: string[]; expiresAt: number }

/**
 * One-time tickets for a multi-item ZIP download (`window.location` cannot send a bearer token).
 * In memory: the server runs as a single replica; a restart only invalidates pending clicks.
 */
@Injectable()
export class ZipTickets {
  private readonly tickets = new Map<string, Ticket>();

  issue(userId: string, itemIds: string[]): { token: string; expiresAt: Date } {
    const now = Date.now();
    for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = now + ZIP_TICKET_TTL_MS;
    this.tickets.set(token, { userId, itemIds, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** The ticket's content, removed on first use; null when unknown or expired. */
  take(token: string): { userId: string; itemIds: string[] } | null {
    const t = this.tickets.get(token);
    this.tickets.delete(token);
    if (!t || t.expiresAt <= Date.now()) return null;
    return { userId: t.userId, itemIds: t.itemIds };
  }
}
