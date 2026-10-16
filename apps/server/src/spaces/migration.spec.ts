import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';

const run = promisify(execFile);
const serverDir = path.join(__dirname, '..', '..');
const migrationsDir = path.join(serverDir, 'prisma', 'migrations');
const BEFORE = '20261015200000_session_revoked_reason';
const PHASE4 = '20261016120000_phase_4_spaces';

/** Private database next to the test DB: `<test db>_mig`. Dropped again after the test. */
function migUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `${u.pathname}_mig`;
  return u.toString();
}

async function deploy(dir: string, url: string): Promise<void> {
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', path.join(dir, 'schema.prisma')], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: url },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function copyMigration(dir: string, name: string): Promise<void> {
  await cp(path.join(migrationsDir, name), path.join(dir, 'migrations', name), { recursive: true });
}

/** Phase 4 migration: personal Space per user (id = user.id), ownerId columns renamed to spaceId. */
describe('phase 4 spaces migration', () => {
  const url = migUrl();
  const name = new URL(url).pathname.slice(1);
  const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  let dir: string;

  beforeAll(async () => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unexpected database name: ${name}`);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-mig-'));
    await cp(path.join(serverDir, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
    await cp(path.join(migrationsDir, 'migration_lock.toml'), path.join(dir, 'migrations', 'migration_lock.toml'));
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps every existing row valid and keyed by the personal space', async () => {
    const all = (await readdir(migrationsDir)).filter((n) => /^\d{14}_/.test(n)).sort();
    for (const m of all.filter((n) => n <= BEFORE)) await copyMigration(dir, m);
    await deploy(dir, url);

    const db = new PrismaClient({ datasourceUrl: url });
    try {
      const userId = '11111111-1111-4111-8111-111111111111';
      const folderId = '22222222-2222-4222-8222-222222222222';
      const fileId = '33333333-3333-4333-8333-333333333333';
      const shareId = '44444444-4444-4444-8444-444444444444';
      await db.$executeRawUnsafe(
        `INSERT INTO "User"(id, username, "displayName", "updatedAt") VALUES ('${userId}', 'alice', 'Alice', now())`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "Item"(id, "ownerId", "parentId", type, name, "nameKey", path, mtime, "updatedAt") VALUES
          ('${folderId}', '${userId}', NULL, 'folder', 'Docs', 'docs', 'Docs', now(), now()),
          ('${fileId}', '${userId}', '${folderId}', 'file', 'a.txt', 'a.txt', 'Docs/a.txt', now(), now())`,
      );
      await db.$executeRawUnsafe(`INSERT INTO "SyncScope"("userId", seq, "minSeq") VALUES ('${userId}', 7, 2)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "FileChange"("scopeId", seq, "itemId", "itemType", op) VALUES
          ('${userId}', 6, '${folderId}', 'folder', 'upsert'), ('${userId}', 7, '${fileId}', 'file', 'upsert')`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "TrashEntry"(id, "ownerId", "itemId", type, name, "originalPath", size, "storePath", manifest)
         VALUES (gen_random_uuid(), '${userId}', gen_random_uuid(), 'file', 'b.txt', 'b.txt', 3, '/meta/trash/x', '[]')`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "FileVersion"(id, "itemId", "ownerId", version, sha, size, mtime, source, "storePath")
         VALUES (gen_random_uuid(), '${fileId}', '${userId}', 1, 'abc', 3, now(), 'api', '/meta/versions/x')`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "ShareLink"(id, "tokenHash", "tokenEnc", "itemId", "ownerId") VALUES ('${shareId}', 'h', 'e', '${fileId}', '${userId}')`,
      );

      await copyMigration(dir, PHASE4);
      await deploy(dir, url);

      const spaces = await db.$queryRawUnsafe<{ id: string; kind: string; name: string; userId: string }[]>(
        `SELECT id::text, kind::text, name, "userId"::text FROM "Space"`,
      );
      expect(spaces).toEqual([{ id: userId, kind: 'personal', name: 'alice', userId }]);

      const items = await db.$queryRawUnsafe<{ spaceId: string }[]>(`SELECT "spaceId"::text FROM "Item"`);
      expect(items).toEqual([{ spaceId: userId }, { spaceId: userId }]);

      const scope = await db.$queryRawUnsafe<{ spaceId: string; seq: bigint; minSeq: bigint }[]>(
        `SELECT "spaceId"::text, seq, "minSeq" FROM "SyncScope"`,
      );
      expect(scope).toEqual([{ spaceId: userId, seq: 7n, minSeq: 2n }]);

      const changes = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "FileChange" WHERE "scopeId" = '${userId}'`,
      );
      expect(changes[0].n).toBe(2n);

      const share = await db.$queryRawUnsafe<{ ownerId: string; spaceId: string }[]>(
        `SELECT "ownerId"::text, "spaceId"::text FROM "ShareLink"`,
      );
      expect(share).toEqual([{ ownerId: userId, spaceId: userId }]);

      const trash = await db.$queryRawUnsafe<{ spaceId: string; deletedBy: string | null }[]>(
        `SELECT "spaceId"::text, "deletedBy"::text FROM "TrashEntry"`,
      );
      expect(trash).toEqual([{ spaceId: userId, deletedBy: null }]);

      const versions = await db.$queryRawUnsafe<{ spaceId: string }[]>(`SELECT "spaceId"::text FROM "FileVersion"`);
      expect(versions).toEqual([{ spaceId: userId }]);

      // Renamed partial unique index still guards live paths per space.
      const idx = await db.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'Item' AND indexname IN ('Item_space_path_live_key', 'Item_space_mtime_idx') ORDER BY 1`,
      );
      expect(idx.map((r) => r.indexname)).toEqual(['Item_space_mtime_idx', 'Item_space_path_live_key']);

      // Deleting the user cascades through its personal space to its items and journal head.
      await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${userId}'`);
      const left = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT (SELECT count(*) FROM "Space") + (SELECT count(*) FROM "Item") + (SELECT count(*) FROM "SyncScope") + (SELECT count(*) FROM "ShareLink") AS n`,
      );
      expect(left[0].n).toBe(0n);
    } finally {
      await db.$disconnect();
    }
  }, 120_000);
});
