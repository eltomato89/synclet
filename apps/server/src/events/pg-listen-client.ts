import { Client } from 'pg';
import type { ListenClient } from './change-notifier';

/**
 * Turns the Prisma `DATABASE_URL` into a connection string for `pg` with the same meaning.
 *
 * - `sslmode`: Prisma follows libpq (`require`/`prefer` encrypt without verifying the
 *   certificate), while `pg` reads them as `verify-full` unless `uselibpqcompat=true` is set, so a
 *   URL that works for Prisma against a self-signed server would never connect here.
 * - `sslaccept=strict` (Prisma: verify the certificate) becomes `sslmode=verify-full`.
 * - Prisma-only parameters (`schema`, `connection_limit`, `pgbouncer`, ...) are dropped.
 */
export function listenConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const q = url.searchParams;
  const strict = q.get('sslaccept') === 'strict';
  for (const k of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'socket_timeout', 'sslaccept', 'sslidentity', 'sslpassword', 'connect_timeout']) q.delete(k);
  const mode = q.get('sslmode');
  if (mode && strict && mode !== 'disable') q.set('sslmode', 'verify-full');
  if (q.has('sslmode') && !q.has('uselibpqcompat')) q.set('uselibpqcompat', 'true');
  return url.toString();
}

/** Prisma's transaction-pooling flag: LISTEN through such a pooler never receives notifications. */
export const usesTransactionPooler = (databaseUrl: string) => new URL(databaseUrl).searchParams.get('pgbouncer') === 'true';

/**
 * Returns a factory for LISTEN clients. `sslmode=prefer` (libpq, Prisma) falls back to an
 * unencrypted connection when the server does not offer TLS; `pg` cannot, so after such a refusal
 * the next attempt connects without TLS.
 */
export function listenClientFactory(databaseUrl: string): () => ListenClient {
  // An unparsable URL fails in createListenClient(), inside the notifier's retry handling.
  const prefer = URL.canParse(databaseUrl) && new URL(databaseUrl).searchParams.get('sslmode') === 'prefer';
  let plain = false;
  return () => {
    const url = new URL(databaseUrl);
    if (plain) url.searchParams.set('sslmode', 'disable');
    const client = createListenClient(url.toString());
    if (!prefer || plain) return client;
    const connect = client.connect.bind(client);
    client.connect = () => connect().catch((e: Error) => {
      if (/does not support SSL/i.test(e.message)) plain = true;
      throw e;
    });
    return client;
  };
}

export function createListenClient(databaseUrl: string): ListenClient {
  const client = new Client({
    connectionString: listenConnectionString(databaseUrl),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'synclet-listen',
  });
  return Object.assign(client, {
    destroy: () => (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy(),
  }) as unknown as ListenClient;
}
