import { type APIRequestContext, expect, type Page, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Shared helpers for the Phase 1b specs. files.spec.ts runs first (Playwright project dependency)
// and creates the administrator; every other spec signs up its own user through the admin API, so
// specs never see each other's files and can run in parallel.

export const BASE_URL = process.env.SYNCLET_URL ?? 'http://localhost:8080';
export const ADMIN = { login: 'e2e', password: 'correct horse battery' };
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/test/fixtures');
export const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

export interface TestUser { username: string; password: string; api: APIRequestContext }

async function tokenFor(login: string, password: string): Promise<string> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.post('/api/auth/login', { data: { login, password } });
    expect(res.ok(), `login ${login}: ${res.status()}`).toBeTruthy();
    return (await res.json()).accessToken as string;
  } finally {
    await ctx.dispose();
  }
}

async function bearer(login: string, password: string): Promise<APIRequestContext> {
  const token = await tokenFor(login, password);
  return request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
}

/** A fresh, empty account (unique username) plus an API client signed in as it. */
export async function newUser(prefix: string): Promise<TestUser> {
  const admin = await bearer(ADMIN.login, ADMIN.password);
  const username = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = 'correct horse battery';
  try {
    const res = await admin.post('/api/admin/users', { data: { username, displayName: username, password } });
    expect(res.status(), await res.text()).toBe(201);
  } finally {
    await admin.dispose();
  }
  return { username, password, api: await bearer(username, password) };
}

/** Signs the browser context in (refresh cookie via the API) and opens My files. */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { login: user.username, password: user.password } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/files');
  await expect(page.getByRole('grid')).toBeVisible();
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
