import { createTestApp, createTestUser, TestContext } from '../../test/context';

describe('Operation model', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('stores an operation with defaults and is removed with its user', async () => {
    const u = await createTestUser(ctx, 'alice');
    const op = await ctx.prisma.operation.create({ data: { userId: u.id, kind: 'copy', status: 'queued', sourceIds: ['f_x'], targetId: 'root' } });
    expect(op).toMatchObject({ nextIndex: 0, doneItems: 0, totalBytes: 0n, results: [], conflict: null, policy: null, finishedAt: null });
    await ctx.prisma.user.delete({ where: { id: u.id } });
    expect(await ctx.prisma.operation.count()).toBe(0);
  });
});
