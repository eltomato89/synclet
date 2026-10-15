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
  // Any other content type: Fastify would answer a bare 415. On the raw-upload sync routes the
  // handler answers instead with a Sync-format 400 invalid_request (the marker body is rejected by
  // rawBody without reading the stream); everywhere else the 415 stays.
  fastify.addContentTypeParser('*', (req, _payload: Readable, done) => {
    if (isRawUploadRoute(req.method, req.url)) {
      done(null, UNSUPPORTED_BODY);
      return;
    }
    const err = Object.assign(new Error(`Unsupported Media Type: ${req.headers['content-type'] ?? ''}`), {
      statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    });
    done(err, undefined);
  });
}

/** Marker body for a sync upload sent with an unsupported Content-Type. */
export const UNSUPPORTED_BODY = Symbol('unsupported-body');

function isRawUploadRoute(method: string, url: string): boolean {
  const p = url.split('?')[0];
  return (method === 'POST' && p === '/api/sync/v1/items/upload') || (method === 'PUT' && /^\/api\/sync\/v1\/items\/[^/]+\/content$/.test(p));
}
