// Vitest global setup: authenticates against SYNCLET_URL, registers a device for the suite and
// creates the suite's own top-level folder `contract-<random>`. The teardown deletes that folder,
// removes its trash entry for good and revokes the suite device, so a run leaves nothing behind.
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { expectStatus, randomSuffix, type Res, SyncletClient } from './client.js';
import type { ContractContext } from './context.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** The web refresh token a login/setup response set as cookie (revoked again at teardown). */
function refreshCookie(res: Res): string | null {
  for (const c of res.headers.getSetCookie()) {
    const m = /^synclet_refresh=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function authenticate(anon: SyncletClient): Promise<{ token: string; webToken: string | null; login: ContractContext['login']; refresh: string | null }> {
  let user = env('SYNCLET_USER');
  let password = env('SYNCLET_PASSWORD');
  if (env('SYNCLET_SETUP') === '1') {
    const status = expectStatus(await anon.get('/setup/status'), 200, 'GET /setup/status').json<{ needsSetup: boolean }>();
    if (status.needsSetup) {
      user ??= 'contract';
      password ??= randomBytes(18).toString('base64url');
      const res = expectStatus(await anon.post('/setup', { username: user, displayName: 'Contract Admin', password }), 201, 'POST /setup');
      return { token: res.json().accessToken, webToken: res.json().accessToken, login: { login: user, password }, refresh: refreshCookie(res) };
    }
    if (!user || !password) throw new Error('SYNCLET_SETUP=1 but the instance is already set up: also pass SYNCLET_USER and SYNCLET_PASSWORD (or SYNCLET_TOKEN)');
  }
  const token = env('SYNCLET_TOKEN');
  if (token) {
    return { token, webToken: token.startsWith('syd_') ? null : token, login: user && password ? { login: user, password } : null, refresh: null };
  }
  if (user && password) {
    const res = expectStatus(await anon.post('/auth/login', { login: user, password }), 200, 'POST /auth/login');
    return { token: res.json().accessToken, webToken: res.json().accessToken, login: { login: user, password }, refresh: refreshCookie(res) };
  }
  throw new Error('Set SYNCLET_TOKEN, or SYNCLET_USER + SYNCLET_PASSWORD, or SYNCLET_SETUP=1 on a fresh instance');
}

/** Ends a web/app session: POST /auth/logout with the refresh token as cookie (always 204). */
export async function revokeRefresh(anon: SyncletClient, refreshToken: string): Promise<void> {
  await anon.request('POST', '/auth/logout', { token: null, headers: { cookie: `synclet_refresh=${refreshToken}` } });
}

export default async function setup(project: TestProject) {
  const baseUrl = env('SYNCLET_URL')?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('SYNCLET_URL is required, e.g. SYNCLET_URL=http://localhost:3190');
  const anon = new SyncletClient(baseUrl);
  const health = await anon.get('/health').catch((e: Error) => { throw new Error(`cannot reach ${baseUrl}: ${e.message}`); });
  expectStatus(health, 200, 'GET /health');

  const auth = await authenticate(anon);
  const primary = anon.withToken(auth.token);
  // The suite works with its own device token, like a native client. A unique installationId keeps
  // the registration from revoking any real device of this user.
  const reg = expectStatus(await primary.post('/sync/v1/devices', {
    name: `sync-contract ${randomSuffix()}`, platform: 'linux', appVersion: '0.0.0-contract', installationId: `contract-${randomBytes(16).toString('hex')}`,
  }), 201, 'POST /sync/v1/devices').json<{ token: string; device: { id: string } }>();
  const api = anon.withToken(reg.token);

  const folderName = `contract-${randomSuffix()}`;
  const folder = expectStatus(await api.mkdir('root', folderName), 201, 'create contract folder').json<{ id: string }>();

  const context: ContractContext = {
    baseUrl, token: reg.token, deviceId: reg.device.id, webToken: auth.webToken, login: auth.login,
    folderId: folder.id, folderName,
    skipThumbnails: env('SYNCLET_SKIP_THUMBNAILS') === '1' ? 'SYNCLET_SKIP_THUMBNAILS=1 (no derivatives worker running)' : null,
    thumbnailTimeoutMs: Number(env('SYNCLET_THUMBNAIL_TIMEOUT_MS') ?? 60_000),
  };
  project.provide('contract', context);

  return async () => {
    const problems: string[] = [];
    const del = await api.del(`/sync/v1/items/${folder.id}`);
    if (del.status !== 204 && del.status !== 404) problems.push(`DELETE contract folder: ${del.status} ${del.text()}`);
    // Remove for good the folder's trash entry and those of items deleted inside it by the tests
    // (an entry whose move to the trash store is still running answers 409: retry).
    const ours = (e: { itemId: string; originalPath: string }) => e.itemId === folder.id || e.originalPath.startsWith(`${folderName}/`);
    for (let attempt = 0; ; attempt++) {
      const list = await api.get('/trash');
      if (list.status !== 200) { problems.push(`GET /trash: ${list.status} ${list.text()}`); break; }
      const entries = list.json<{ id: string; itemId: string; originalPath: string }[]>().filter(ours);
      if (entries.length === 0) break;
      const busy: string[] = [];
      for (const entry of entries) {
        const res = await api.del(`/trash/${entry.id}`);
        if (res.status === 409) busy.push(entry.id);
        else if (res.status !== 204 && res.status !== 404) problems.push(`DELETE /trash/${entry.id}: ${res.status} ${res.text()}`);
      }
      if (busy.length === 0) break;
      if (attempt === 30) { problems.push(`trash entries still busy: ${busy.join(', ')}`); break; }
      await sleep(500);
    }
    // End the web session the suite's own login opened (the access token simply expires).
    if (auth.refresh) await revokeRefresh(anon, auth.refresh);
    const revoke = await api.del('/sync/v1/devices/current');
    if (revoke.status !== 204) problems.push(`revoke suite device: ${revoke.status} ${revoke.text()}`);
    if (problems.length) throw new Error(`contract cleanup incomplete:\n${problems.join('\n')}`);
  };
}
