import { createHash, randomBytes } from 'node:crypto';

export function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url'); // 43 chars
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
