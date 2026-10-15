import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';

const run = promisify(execFile);
const serverDir = path.join(__dirname, '..');

/** Shadow DB for `migrate diff`: SCHEMA_DRIFT_SHADOW_URL, or `<test db>_shadow` on the same server. */
function shadowUrl(): string {
  if (process.env.SCHEMA_DRIFT_SHADOW_URL) return process.env.SCHEMA_DRIFT_SHADOW_URL;
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `${u.pathname}_shadow`;
  return u.toString();
}

async function ensureDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unexpected shadow database name: ${name}`);
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const rows = await prisma.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Guards against schema drift: applying all migrations must yield exactly what schema.prisma
 * describes. Otherwise the next `prisma migrate dev` would generate DROP statements (e.g. for
 * the raw-SQL ItemText.tsv column and its GIN index).
 */
describe('prisma schema drift', () => {
  it('migrations and schema.prisma are in sync', async () => {
    const shadow = shadowUrl();
    try {
      await ensureDatabase(shadow);
    } catch (err) {
      console.warn(`skipped schema drift check (cannot create shadow DB): ${(err as Error).message}`);
      return;
    }
    const args = [
      'prisma', 'migrate', 'diff',
      '--from-migrations', 'prisma/migrations',
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--shadow-database-url', shadow,
      '--script', '--exit-code',
    ];
    try {
      await run('pnpm', ['exec', ...args], { cwd: serverDir, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
      if (e.code === 2) {
        throw new Error(`schema.prisma drifts from prisma/migrations; the next migration would run:\n${e.stdout}`);
      }
      // Only environmental failures skip: CLI missing, or the DB server unreachable / access denied.
      const output = `${e.stderr ?? ''}${e.stdout ?? ''}`;
      if (e.code === 'ENOENT' || /\bP10(00|01|03|10)\b/.test(output)) {
        console.warn(`skipped schema drift check (prisma CLI or shadow DB not usable): ${output || e.message}`);
        return;
      }
      throw err;
    }
  }, 120_000);
});
