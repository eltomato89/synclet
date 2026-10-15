import { Injectable } from '@nestjs/common';
import type { Item, VersionSource } from '@prisma/client';
import type { IndexUser } from '../common/types';
import type { Tx } from '../journal/journal.service';

/**
 * STUB (Phase 1c Task 3): placeholder until Task 2's VersionsService is merged. Only the
 * `capture` signature is relied on by FilesService; Task 2 replaces this file.
 */
@Injectable()
export class VersionsService {
  /** Keeps the current content of `item` (at `absCurrent`) as a version before it is replaced. */
  async capture(_tx: Tx, _user: IndexUser, _item: Item, _absCurrent: string, _source: VersionSource, _by?: string): Promise<void> {
    // no-op until Task 2
  }
}
