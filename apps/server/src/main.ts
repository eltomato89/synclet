import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ trustProxy: config.trustProxy, bodyLimit: 10 * 1024 * 1024 }),
  );
  await configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void main();
