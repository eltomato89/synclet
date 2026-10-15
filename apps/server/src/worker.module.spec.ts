import { Test } from '@nestjs/testing';
import { loadConfig } from './config';
import { PrismaService } from './prisma/prisma.service';
import { WorkerModule } from './worker.module';
import { WorkerRunner } from './worker/worker-runner';

describe('WorkerModule', () => {
  it('compiles and the runner resolves after stop()', async () => {
    const config = { ...loadConfig({}), role: 'worker' as const };
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }).compile();
    const app = await moduleRef.init();
    const runner = app.get(WorkerRunner);
    let done = false;
    const running = runner.run().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    runner.stop();
    await running;
    expect(done).toBe(true);
    await app.get(PrismaService).$disconnect();
    await app.close();
  });
});
