import { type APIRequestContext, type APIResponse, type BrowserContext, expect, type Page, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Shared helpers for the specs. Project order (playwright.config.ts): files.spec.ts runs the
// first-run setup and leaves the administrator; users.setup.ts signs in as it once and creates one
// account per spec (SPEC_USERS); each spec then signs in once as its own user, so specs never see
// each other's files and can run in parallel. admin.spec.ts and sso.spec.ts change server-wide
// state and run last, one after the other. Logins are few on purpose: the server allows 10 per
// client IP in a burst, then one per 6 s (login, app login); `login` waits out a 429.

export const BASE_URL = process.env.SYNCLET_URL ?? 'http://localhost:8080';
export const ADMIN = { login: 'e2e', password: 'correct horse battery' };
export const SPEC_USERS = ['trash', 'share', 'preview', 'search', 'upload', 'versions', 'applogin', 'office', 'owner'] as const;
export type SpecUser = (typeof SPEC_USERS)[number];
export const USER_PASSWORD = 'correct horse battery';
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/test/fixtures');
export const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

export interface TestUser { username: string; api: APIRequestContext }

/** Set by scripts/e2e-fresh.sh. */
export const E2E = {
  dataDir: process.env.E2E_DATA_DIR ?? '',
  oidcIssuer: process.env.E2E_OIDC_ISSUER ?? '',
  forwardUrl: process.env.E2E_FORWARD_URL ?? '',
  networkCidr: process.env.E2E_NETWORK_CIDR ?? '',
  office: process.env.E2E_OFFICE === '1',
  officeUrl: process.env.E2E_OFFICE_URL ?? '',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Seconds of a 429's Retry-After (1–30). */
const retryAfter = (headers: Record<string, string>) => Math.min(30, Math.max(1, Number(headers['retry-after']) || 6));

/** Runs an API call again after its 429's Retry-After (sign-in endpoints share one per-IP budget). */
export async function retryRateLimited(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await call();
    if (res.status() !== 429 || attempt >= 8) return res;
    await sleep(retryAfter(res.headers()) * 1000);
  }
}

/** Password login through the API (the refresh cookie lands in `ctx`); waits out rate limiting. */
export async function login(ctx: APIRequestContext, username: string, password: string): Promise<string> {
  const res = await retryRateLimited(() => ctx.post('/api/auth/login', { data: { login: username, password } }));
  expect(res.ok(), `login ${username}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).accessToken as string;
}

/**
 * The per-IP limit of the sign-in endpoints is shared by every spec (one client address). For
 * flows driven through the UI, repeat a rate-limited call after its Retry-After instead of
 * failing on a limit that only exists because the whole suite signs in from one address.
 */
export async function waitOutRateLimits(ctx: BrowserContext): Promise<void> {
  await ctx.route(/\/api\/auth\/(login|forward|app\/)/, async (route) => {
    for (let attempt = 0; ; attempt++) {
      const res = await route.fetch({ maxRedirects: 0 });
      if (res.status() !== 429 || attempt >= 8) return route.fulfill({ response: res });
      await sleep(retryAfter(res.headers()) * 1000);
    }
  });
}

/** API client authenticated with `token`. */
export const apiAs = (token: string) => request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });

/** Signs in as the administrator through the API (cookie in `page`'s context) and returns an API client. */
export async function signInAdmin(page: Page): Promise<APIRequestContext> {
  return apiAs(await login(page.request, ADMIN.login, ADMIN.password));
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
  return { username: `e2e-${username}`, api: await apiAs(token) };
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
