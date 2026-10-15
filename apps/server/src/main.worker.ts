import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { WorkerModule } from './worker.module';
import { WorkerRunner } from './worker/worker-runner';

async function main() {
  const config = { ...loadConfig(), role: 'worker' as const };
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config));
  const runner = app.get(WorkerRunner);
  const shutdown = () => runner.stop();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await runner.run();
  await app.close();
}

void main();
