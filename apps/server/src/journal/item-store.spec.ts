import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { ItemStore } from './item-store';

describe('ItemStore', () => {
  let ctx: TestContext; let store: ItemStore; let user: IndexUser;
  beforeEach(async () => { ctx = await createTestApp(); store = ctx.app.get(ItemStore); user = await createTestUser(ctx); });
  afterEach(async () => { await ctx.close(); });

  const mk = (path: string, type: 'folder' | 'file', parentId: string | null) =>
    ctx.prisma.item.create({ data: { ownerId: user.id, parentId, type, name: path.split('/').pop()!, nameKey: path.split('/').pop()!.toLowerCase(), path, mtime: new Date() } });

  it('rewrites descendant paths on folder move (unicode-safe)', async () => {
    const a = await mk('Ä 🚀', 'folder', null);
    const b = await mk('Ä 🚀/sub', 'folder', a.id);
    await mk('Ä 🚀/sub/f.txt', 'file', b.id);
    await mk('Ä 🚀 other/x', 'file', null); // same prefix without slash must not change
    await ctx.prisma.$transaction((tx) => store.rewritePrefix(tx, user.id, 'Ä 🚀', 'moved/Ä 🚀'));
    const paths = (await ctx.prisma.item.findMany({ orderBy: { path: 'asc' } })).map((i) => i.path);
    expect(paths).toEqual(['moved/Ä 🚀/sub', 'moved/Ä 🚀/sub/f.txt', 'Ä 🚀', 'Ä 🚀 other/x'].sort());
  });

  it('tombstones a subtree and hides it from live queries', async () => {
    const a = await mk('a', 'folder', null);
    await mk('a/x', 'file', a.id);
    const gone = await ctx.prisma.$transaction((tx) => store.tombstoneSubtree(tx, a));
    expect(gone).toHaveLength(2);
    expect(await ctx.prisma.$transaction((tx) => store.liveChildren(tx, user.id, null))).toEqual([]);
  });

  it('finds siblings sharing a name key', async () => {
    const x = await mk('Doc.md', 'file', null);
    const y = await ctx.prisma.item.create({ data: { ownerId: user.id, parentId: null, type: 'file', name: 'doc.md', nameKey: 'doc.md', path: 'doc.md', mtime: new Date() } });
    const res = await ctx.prisma.$transaction((tx) => store.sameKeySiblings(tx, user.id, null, ['doc.md'], new Set([x.id])));
    expect(res.map((r) => r.id)).toEqual([y.id]);
  });
});
