import { createRequire } from 'node:module';
import { listenClientFactory, listenConnectionString, usesTransactionPooler } from './pg-listen-client';

// The parser of the installed `pg` (a transitive dependency), exactly what the client will use.
const { parse } = createRequire(require.resolve('pg'))('pg-connection-string') as { parse(s: string): { ssl?: unknown } };
const ssl = (url: string) => parse(listenConnectionString(url)).ssl as false | { rejectUnauthorized?: boolean } | undefined;

describe('listenConnectionString (Prisma DATABASE_URL → pg)', () => {
  it('leaves a plain URL alone', () => {
    expect(listenConnectionString('postgresql://u:p@db:5432/synclet')).toBe('postgresql://u:p@db:5432/synclet');
    expect(ssl('postgresql://u:p@db:5432/synclet')).toBeUndefined();
  });

  it('sslmode=require / prefer encrypt without verifying the certificate (libpq semantics, like Prisma)', () => {
    expect(listenConnectionString('postgresql://u:p@db/s?sslmode=require')).toContain('uselibpqcompat=true');
    expect(ssl('postgresql://u:p@db/s?sslmode=require')).toMatchObject({ rejectUnauthorized: false });
    expect(ssl('postgresql://u:p@db/s?sslmode=prefer')).toMatchObject({ rejectUnauthorized: false });
    expect(ssl('postgresql://u:p@db/s?sslmode=disable')).toBe(false);
  });

  it('verify-full and sslaccept=strict verify the certificate', () => {
    expect(ssl('postgresql://u:p@db/s?sslmode=verify-full')).toEqual({});
    expect(ssl('postgresql://u:p@db/s?sslmode=require&sslaccept=strict')).toEqual({});
  });

  it('keeps an explicit uselibpqcompat and drops Prisma-only parameters', () => {
    const s = listenConnectionString('postgresql://u:p@db/s?sslmode=require&uselibpqcompat=true&schema=public&connection_limit=5&pgbouncer=true');
    expect(new URL(s).searchParams.getAll('uselibpqcompat')).toEqual(['true']);
    for (const k of ['schema', 'connection_limit', 'pgbouncer']) expect(new URL(s).searchParams.has(k)).toBe(false);
  });

  it("maps Prisma's sslcert (server CA) to sslrootcert with sslaccept=strict, else drops it", () => {
    const strict = new URL(listenConnectionString('postgresql://u:p@db/s?sslmode=require&sslaccept=strict&sslcert=./certs/ca.pem', '/app/prisma')).searchParams;
    expect(strict.get('sslrootcert')).toBe('/app/prisma/certs/ca.pem');
    expect(strict.has('sslcert')).toBe(false);
    expect(strict.get('sslmode')).toBe('verify-full');
    const abs = new URL(listenConnectionString('postgresql://u:p@db/s?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/ca.pem', '/app/prisma')).searchParams;
    expect(abs.get('sslrootcert')).toBe('/etc/ssl/ca.pem');
    const lax = new URL(listenConnectionString('postgresql://u:p@db/s?sslmode=require&sslcert=./ca.pem', '/app/prisma')).searchParams;
    expect(lax.has('sslcert')).toBe(false);
    expect(lax.has('sslrootcert')).toBe(false);
    expect(ssl('postgresql://u:p@db/s?sslmode=require&sslcert=./ca.pem')).toMatchObject({ rejectUnauthorized: false });
  });

  it("detects Prisma's transaction-pooler flag", () => {
    expect(usesTransactionPooler('postgresql://u:p@db/s?pgbouncer=true')).toBe(true);
    expect(usesTransactionPooler('postgresql://u:p@db/s')).toBe(false);
  });
});

describe('listenClientFactory', () => {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');

  it('connects to the test database and LISTENs', async () => {
    const c = listenClientFactory(url)();
    await c.connect();
    await c.query('LISTEN synclet_changes');
    await c.end();
  });

  it.each(['sslmode=require', 'sslmode=verify-full', 'sslmode=require&sslaccept=strict', 'sslmode=verify-full&sslaccept=strict'])(
    '%s never falls back to plaintext (server without TLS: every attempt fails)', async (params) => {
      const make = listenClientFactory(`${url}?${params}`);
      for (let i = 0; i < 3; i++) {
        const c = make();
        await expect(c.connect()).rejects.toThrow(/does not support SSL/i);
        await c.end().catch(() => undefined);
      }
    });

  it('sslmode=prefer against a server without TLS falls back to plain on the next attempt', async () => {
    const make = listenClientFactory(`${url}?sslmode=prefer`);
    const first = make();
    let tls = true;
    try {
      await first.connect();
    } catch (e) {
      expect((e as Error).message).toMatch(/does not support SSL/i);
      tls = false;
    }
    if (tls) {
      // The test server offers TLS: nothing to fall back from.
      await first.end();
      return;
    }
    const second = make();
    await second.connect();
    await second.query('SELECT 1');
    await second.end();
  });
});
