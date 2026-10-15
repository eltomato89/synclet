import { type APIRequestContext, expect, type Page, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Shared helpers for the Phase 1b specs. Project order (playwright.config.ts): files.spec.ts runs
// the first-run setup and leaves the administrator; users.setup.ts signs in as it once and creates
// one account per spec (SPEC_USERS); each spec then signs in once as its own user, so specs never
// see each other's files and can run in parallel. Logins are few on purpose: the server allows 10
// per client IP in a burst, then one per 6 s.

export const BASE_URL = process.env.SYNCLET_URL ?? 'http://localhost:8080';
export const ADMIN = { login: 'e2e', password: 'correct horse battery' };
export const SPEC_USERS = ['trash', 'share', 'preview', 'search', 'upload'] as const;
export type SpecUser = (typeof SPEC_USERS)[number];
export const USER_PASSWORD = 'correct horse battery';
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/test/fixtures');
export const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

export interface TestUser { username: string; api: APIRequestContext }

export async function login(ctx: APIRequestContext, username: string, password: string): Promise<string> {
  const res = await ctx.post('/api/auth/login', { data: { login: username, password } });
  expect(res.ok(), `login ${username}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).accessToken as string;
}

/**
 * Signs the browser context in as the spec's user (the refresh cookie lands in the context), opens
 * My files, and returns an API client using the same session's access token.
 */
export async function signIn(page: Page, username: SpecUser): Promise<TestUser> {
  const token = await login(page.request, `e2e-${username}`, USER_PASSWORD);
  await page.goto('/files');
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.locator('#main')).toBeVisible();
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  return { username: `e2e-${username}`, api };
}

export async function mkdir(api: APIRequestContext, parentId: string, name: string): Promise<string> {
  const res = await api.post('/api/sync/v1/items', { data: { parentId, type: 'folder', name } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

export async function upload(api: APIRequestContext, parentId: string, name: string, data: string | Buffer): Promise<string> {
  const res = await api.post(`/api/sync/v1/items/upload?parentId=${encodeURIComponent(parentId)}&name=${encodeURIComponent(name)}`, {
    headers: { 'content-type': 'application/octet-stream' },
    data: typeof data === 'string' ? Buffer.from(data) : data,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

/** Waits (≤ 90 s) until the worker has produced the item's thumbnail. */
export async function waitForThumbnail(api: APIRequestContext, id: string): Promise<void> {
  await expect.poll(async () => (await api.get(`/api/sync/v1/items/${id}/thumbnail`)).status(), { timeout: 90_000, intervals: [500, 1000] }).toBe(200);
}

/** One row of the file list (role=grid), matched by the exact name. */
export const row = (page: Page, name: string) =>
  page.getByRole('grid').getByRole('row').filter({ has: page.getByTitle(name, { exact: true }) });

/** A one-page PDF showing `text` (ASCII) in Helvetica, with a correct xref table. */
export function textPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 50 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Entries of a ZIP (name → content; directories end with `/` and map to an empty buffer), read
 * from the central directory. Handles stored and deflated entries, which is all the server writes.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 not supported here');
  const out = new Map<string, Buffer>();
  while (count-- > 0) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compressed);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
