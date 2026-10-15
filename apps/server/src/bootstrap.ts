import cookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Readable } from 'node:stream';
import { SyncErrorFilter } from './common/sync-error';

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SyncErrorFilter());
  await app.register(cookie as never);
  const fastify = app.getHttpAdapter().getInstance();
  // Raw uploads: application/octet-stream bodies are passed through as a stream (never buffered).
  fastify.addContentTypeParser('application/octet-stream', (req, payload: Readable, done) => {
    if (!req.url.startsWith('/api/sync/')) {
      const err = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
      done(err, undefined);
      return;
    }
    done(null, payload);
  });
}
