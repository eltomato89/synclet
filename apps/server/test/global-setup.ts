import { execSync } from 'node:child_process';
import path from 'node:path';

export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://synclet:synclet@localhost:5434/synclet_test';
  // The test DB is migrated, not reset (non-destructive); tables are truncated per test by resetDb().
  execSync('pnpm prisma migrate deploy', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
