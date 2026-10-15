/**
 * Emergency recovery: gives `<username>` a local password, enables the account and makes it an admin.
 *
 *   docker compose exec server node dist/cli/reset-admin-password.js <username>
 *   echo 'new password' | docker compose exec -T server node dist/cli/reset-admin-password.js <username>
 *
 * Without a password on stdin a random one is generated and printed. All sessions of the user are
 * revoked. Combine with SYNCLET_SSO_EMERGENCY=1 when SSO is broken.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { setLocalPassword } from '../auth/users.service';

export interface ResetAdminResult { username: string; password: string; generated: boolean }

export async function resetAdminPassword(prisma: PrismaClient, username: string, password?: string | null): Promise<ResetAdminResult> {
  const generated = !password;
  const pw = password || randomBytes(18).toString('base64url');
  if (pw.length < 10 || pw.length > 200) throw new Error('password must be 10–200 characters');
  const passwordHash = await argon2.hash(pw, { type: argon2.argon2id });
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.findFirst({ where: { username: { equals: username.trim(), mode: 'insensitive' } } });
    if (!u) throw new Error(`no user named "${username}"`);
    await setLocalPassword(tx, u, passwordHash);
    await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return tx.user.update({ where: { id: u.id }, data: { role: 'admin', disabledAt: null } });
  });
  return { username: user.username, password: pw, generated };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('usage: node dist/cli/reset-admin-password.js <username>   (optional: new password on stdin)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const r = await resetAdminPassword(prisma, username, await readStdin());
    console.log(`${r.username} is now an enabled admin with a local password.`);
    if (r.generated) console.log(`Generated password: ${r.password}`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
