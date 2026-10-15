import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { TX_OPTS } from '../prisma/prisma.service';
import { JournalService } from './journal.service';

describe('JournalService', () => {
  let ctx: TestContext; let journal: JournalService; let user: IndexUser;
  beforeEach(async () => {
    ctx = await createTestApp();
    journal = ctx.app.get(JournalService);
    user = await createTestUser(ctx);
  });
  afterEach(async () => { await ctx.close(); });

  const ref = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'file' as const });
  const rec = (refs: ReturnType<typeof ref>[], op: 'upsert' | 'delete' = 'upsert') =>
    ctx.prisma.$transaction(async (tx) => { await journal.lockUser(tx, user.id); await journal.record(tx, user.id, refs, op); }, TX_OPTS);

  it('starts at cursor 0 and advances one seq per distinct item', async () => {
    expect(await journal.currentCursor(user.id)).toBe('0');
    await rec([ref(1), ref(2), ref(1)]);
    expect(await journal.currentCursor(user.id)).toBe('2');
  });

  it('collapses multiple changes per item and pages by max seq', async () => {
    await rec([ref(1)]); await rec([ref(2)]); await rec([ref(1)], 'delete'); await rec([ref(3)]);
    const p1 = await journal.changesSince(user.id, '0', 2);
    expect(p1.entries.map((e) => e.itemId)).toEqual([ref(2).id, ref(1).id]);
    expect(p1.hasMore).toBe(true);
    const p2 = await journal.changesSince(user.id, p1.cursor, 2);
    expect(p2.entries.map((e) => e.itemId)).toEqual([ref(3).id]);
    expect(p2.hasMore).toBe(false);
    expect(p2.cursor).toBe('4');
    const p3 = await journal.changesSince(user.id, p2.cursor, 2);
    expect(p3.entries).toEqual([]);
    expect(p3.cursor).toBe('4');
  });

  it('rejects malformed, future and trimmed cursors', async () => {
    await rec([ref(1)]); await rec([ref(2)]);
    await expect(journal.changesSince(user.id, 'abc', 10)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(journal.changesSince(user.id, '99', 10)).rejects.toMatchObject({ code: 'cursor_expired' });
    await journal.trim(user.id, new Date(Date.now() + 1000));
    await expect(journal.changesSince(user.id, '0', 10)).rejects.toMatchObject({ code: 'cursor_expired' });
    expect((await journal.changesSince(user.id, '2', 10)).entries).toEqual([]);
  });

  it('serializes concurrent writers: seqs are gap-free in commit order', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => rec([ref(i + 1)])));
    const page = await journal.changesSince(user.id, '0', 100);
    expect(page.entries.map((e) => Number(e.seq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
