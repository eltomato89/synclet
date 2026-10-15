import { importEsm } from './import-esm';

describe('importEsm', () => {
  it('loads ESM-only packages (openid-client)', async () => {
    const oidc = await importEsm<typeof import('openid-client')>('openid-client');
    expect(typeof oidc.discovery).toBe('function');
    expect(typeof oidc.randomPKCECodeVerifier).toBe('function');
  });

  it('loads node builtins', async () => {
    const os = await importEsm<typeof import('node:os')>('node:os');
    expect(typeof os.tmpdir()).toBe('string');
  });
});
