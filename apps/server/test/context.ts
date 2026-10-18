import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfig, loadConfig } from '../src/config';
import { PrismaService } from '../src/prisma/prisma.service';
import type { IndexSpace, IndexUser } from '../src/common/types';

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  config: AppConfig;
  close(): Promise<void>;
}

export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Operation","FileVersion","AppAuthCode","AuthSettings","DerivativeJob","ItemText","ShareLink","FileChange","SyncScope","TrashEntry","Item","SpaceMember","GroupMember","Group","Space","SyncDevice","Session","Identity","User","ServerConfig" CASCADE',
  );
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-data-'));
  const metaRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-meta-'));
  // Never the real /teams and /storage of the test host.
  const teamsRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-teams-'));
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-storage-'));
  const config: AppConfig = { ...loadConfig({}), dataRoot, metaRoot, teamsRoot, storageRoot, background: false, updateCheck: false, ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const prisma = app.get(PrismaService);
  await resetDb(prisma);
  return {
    app, prisma, config,
    async close() {
      await app.close();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(metaRoot, { recursive: true, force: true });
      await rm(teamsRoot, { recursive: true, force: true });
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Inserts a user directly (no auth module needed) with its personal space, and creates its folder. */
export async function createTestUser(ctx: TestContext, username = 'alice'): Promise<IndexUser> {
  const user = await ctx.prisma.user.create({ data: { username, displayName: username } });
  const space = personalSpace(ctx, { id: user.id, username });
  await ctx.prisma.space.create({ data: { id: user.id, kind: 'personal', name: username, rootPath: space.rootPath, userId: user.id } });
  await ctx.prisma.syncScope.create({ data: { spaceId: user.id } });
  await mkdir(space.rootPath, { recursive: true });
  return { id: user.id, username };
}

/** Creates a team (or external) space folder below teamsRoot (storageRoot) with its row and journal head. */
export async function createTestSpace(ctx: TestContext, name: string, kind: 'team' | 'external' = 'team', extra: { readOnly?: boolean; watch?: 'auto' | 'off'; status?: 'available' | 'missing' } = {}): Promise<IndexSpace> {
  const rootPath = path.join(kind === 'team' ? ctx.config.teamsRoot : ctx.config.storageRoot, name);
  await mkdir(rootPath, { recursive: true });
  const row = await ctx.prisma.space.create({ data: { id: randomUUID(), kind, name, rootPath, ...extra } });
  await ctx.prisma.syncScope.create({ data: { spaceId: row.id } });
  return { id: row.id, kind, rootPath };
}

/** The personal space of a test user (id = user id, root = <dataRoot>/<username>). */
export function personalSpace(ctx: TestContext, user: IndexUser): IndexSpace {
  return { id: user.id, kind: 'personal', rootPath: path.join(ctx.config.dataRoot, user.username) };
}

let caseSensitive: boolean | undefined;
async function detectCaseSensitive(): Promise<boolean> {
  if (caseSensitive !== undefined) return caseSensitive;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-case-'));
  await writeFile(path.join(dir, 'a'), '');
  caseSensitive = await stat(path.join(dir, 'A')).then(() => false, () => true);
  await rm(dir, { recursive: true, force: true });
  return caseSensitive;
}

/** Runs the test only on case-sensitive file systems (Linux); skips it on macOS APFS. */
export function itIfCaseSensitive(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!(await detectCaseSensitive())) {
      console.warn(`skipped on case-insensitive FS: ${name}`);
      return;
    }
    await fn();
  });
}
