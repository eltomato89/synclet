import { expect, request, test } from '@playwright/test';
import { ADMIN, BASE_URL, login, SPEC_USERS, USER_PASSWORD } from './helpers';

// One account per Phase 1b spec, created by the administrator from files.spec.ts.
test('create the spec users', async () => {
  const anon = await request.newContext({ baseURL: BASE_URL });
  const token = await login(anon, ADMIN.login, ADMIN.password);
  await anon.dispose();
  const admin = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  for (const name of SPEC_USERS) {
    const res = await admin.post('/api/admin/users', { data: { username: `e2e-${name}`, displayName: `E2E ${name}`, password: USER_PASSWORD } });
    expect(res.status(), await res.text()).toBe(201);
  }
  await admin.dispose();
});
