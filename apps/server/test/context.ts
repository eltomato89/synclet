import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
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
    'TRUNCATE "FileVersion","AppAuthCode","AuthSettings","DerivativeJob","ItemText","ShareLink","FileChange","SyncScope","TrashEntry","Item","SpaceMember","GroupMember","Group","Space","SyncDevice","Session","Identity","User","ServerConfig" CASCADE',
  );
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-data-'));
  const metaRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-meta-'));
  const config: AppConfig = { ...loadConfig({}), dataRoot, metaRoot, background: false, ...overrides };
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
