import type { AppConfig } from '../config';
import type { SchedulerService } from '../indexer/scheduler.service';
import { OperationsRunner } from './operations.runner';

describe('OperationsRunner boot', () => {
  it('recovers and starts claiming only after the scheduler startup cleanup', async () => {
    let done!: () => void;
    const startupDone = new Promise<void>((r) => { done = r; });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = { operation: { updateMany }, $queryRaw: queryRaw };
    const runner = new OperationsRunner(prisma as never, {} as never, {} as never, {} as never, { startupDone } as unknown as SchedulerService, { background: true } as AppConfig);
    runner.onApplicationBootstrap();
    runner.kick(); // e.g. an operation created right after listen
    await new Promise((r) => setImmediate(r));
    expect(updateMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    done();
    await runner.booted;
    await runner.idle();
    expect(updateMany).toHaveBeenCalledWith({ where: { status: 'running' }, data: { status: 'queued' } });
    expect(queryRaw).toHaveBeenCalled();
    await runner.onModuleDestroy();
  });
});
