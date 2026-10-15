import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { randomSuffix } from '../src/client.js';
import { contract } from '../src/context.js';
import { arrayErrors, schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

/** Devices registered by this file; whatever a failing test left active is revoked afterwards. */
const registered: string[] = [];
const register = async (name: string, installationId?: string) => {
  const res = await api.post('/sync/v1/devices', { name, platform: 'linux', appVersion: '1.2.3', ...(installationId ? { installationId } : {}) });
  if (res.status === 201) registered.push(res.json().device.id);
  return res;
};
afterAll(async () => {
  for (const id of registered) {
    const res = await api.del(`/sync/v1/devices/${id}`);
    if (res.status !== 204 && res.status !== 404) throw new Error(`cannot revoke test device ${id}: ${res.status}`);
  }
});

describe('authentication', () => {
  it('rejects requests without or with a bogus token: 401 unauthorized', async () => {
    for (const token of [null, 'syd_bogus', 'not-a-jwt']) {
      const res = await api.get('/sync/v1/account', { token });
      expect(res.status).toBe(401);
      expect(res.json()).toMatchObject({ statusCode: 401, code: 'unauthorized' });
      expect(schemaErrors('Error', res.json())).toBe('');
    }
  });
});

describe('devices', () => {
  it('registers a device: 201 with device, one-time token and account', async () => {
    const res = await register(`contract ${randomSuffix()}`, `contract-${randomBytes(8).toString('hex')}`);
    expect(res.status).toBe(201);
    const body = res.json();
    expect(schemaErrors('DeviceRegistration', body)).toBe('');
    expect(body.token).toMatch(/^syd_[A-Za-z0-9_-]{43}$/);
    expect(body.device).toMatchObject({ platform: 'linux', appVersion: '1.2.3' });
    // The new token works, sees itself as current, and can sign itself out.
    const own = api.withToken(body.token);
    const list = (await own.get('/sync/v1/devices')).json();
    expect(arrayErrors('SyncDevice', list)).toBe('');
    expect(list.find((d: { id: string }) => d.id === body.device.id)).toMatchObject({ current: true });
    expect(list.filter((d: { current: boolean }) => d.current)).toHaveLength(1);
    expect((await own.del('/sync/v1/devices/current')).status).toBe(204);
    const after = await own.get('/sync/v1/account');
    expect(after.status).toBe(401);
    expect(after.json().code).toBe('device_revoked');
  });

  it('validates the registration body: 400 invalid_request', async () => {
    const res = await api.post('/sync/v1/devices', { name: 'x', platform: 'amiga', appVersion: '1' });
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('re-registration with the same installationId revokes the older device', async () => {
    const installationId = `contract-${randomBytes(8).toString('hex')}`;
    const first = (await register(`contract ${randomSuffix()}`, installationId)).json();
    const second = (await register(`contract ${randomSuffix()}`, installationId)).json();
    const old = await api.get('/sync/v1/cursor', { token: first.token });
    expect(old.status).toBe(401);
    expect(old.json().code).toBe('device_revoked');
    const ids = (await api.get('/sync/v1/devices')).json().map((d: { id: string }) => d.id);
    expect(ids).not.toContain(first.device.id);
    expect(ids).toContain(second.device.id);
    expect((await api.del(`/sync/v1/devices/${second.device.id}`)).status).toBe(204);
    expect((await api.get('/sync/v1/cursor', { token: second.token })).json().code).toBe('device_revoked');
  });

  it('lists the suite device as current', async () => {
    const list = (await api.get('/sync/v1/devices')).json();
    expect(list.find((d: { id: string }) => d.id === ctx.deviceId)).toMatchObject({ current: true });
  });

  it('revoking an unknown or malformed device id is 404 not_found', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const res = await api.del(`/sync/v1/devices/${id}`);
      expect(res.status).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
  });

  it('DELETE /devices/current needs a device token (400 with a web token)', async (t) => {
    if (!ctx.webToken) t.skip('no web access token (SYNCLET_TOKEN is a device token)');
    const res = await api.del('/sync/v1/devices/current', { token: ctx.webToken });
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('accepts a push token (204, ignored until APNs support)', async () => {
    const res = await api.request('PUT', '/sync/v1/devices/current/push', { json: { token: 'abcd', environment: 'sandbox' } });
    expect(res.status).toBe(204);
  });
});

describe('account', () => {
  it('describes the account, limits and the current cursor', async () => {
    const res = await api.get('/sync/v1/account');
    expect(res.status).toBe(200);
    const acc = res.json();
    expect(schemaErrors('SyncAccount', acc)).toBe('');
    expect(acc).toMatchObject({ organizationName: 'Synclet', canWrite: true, areas: { personal: true, shared: false, customers: false, projects: false } });
    expect(acc.organizationId).toBe(`${acc.organizationId.split(':')[0]}:${acc.userId}`);
    expect(Array.isArray(acc.spaces) && acc.spaces.length).toBeGreaterThanOrEqual(1);
    for (const sp of acc.spaces) {
      expect(typeof sp.id).toBe('string');
      expect(typeof sp.name).toBe('string');
      expect(typeof sp.rootId).toBe('string');
      expect(['personal', 'shared', 'external']).toContain(sp.kind);
    }
    const cursor = await api.get('/sync/v1/cursor');
    expect(schemaErrors('CursorResponse', cursor.json())).toBe('');
    const me = await api.get('/auth/me');
    expect(me.json()).toMatchObject({ id: acc.userId, username: acc.slug, displayName: acc.displayName });
  });
});
