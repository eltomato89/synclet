import { loadConfig } from './config';

describe('loadConfig', () => {
  it('phase 4: teams and storage roots default to /teams and /storage', () => {
    expect(loadConfig({})).toMatchObject({ teamsRoot: '/teams', storageRoot: '/storage' });
    expect(loadConfig({ SYNCLET_TEAMS_ROOT: '', SYNCLET_STORAGE_ROOT: '' })).toMatchObject({ teamsRoot: '/teams', storageRoot: '/storage' });
    expect(loadConfig({ SYNCLET_TEAMS_ROOT: '/srv/t', SYNCLET_STORAGE_ROOT: '/srv/s' })).toMatchObject({ teamsRoot: '/srv/t', storageRoot: '/srv/s' });
  });

  it('treats empty values (compose `${VAR:-}`) as unset', () => {
    const c = loadConfig({
      SYNCLET_MASS_DELETE_THRESHOLD: '', SYNCLET_TOMBSTONE_WINDOW: '', SYNCLET_JOURNAL_RETENTION_DAYS: '',
      SYNCLET_SECURE_COOKIES: '', SYNCLET_PUBLIC_URL: '', SYNCLET_SCAN_INTERVAL: '', SYNCLET_MAX_UPLOAD_BYTES: '',
    });
    expect(c).toMatchObject({ massDeleteThreshold: 25, tombstoneWindowSec: 3600, journalRetentionDays: 30, secureCookies: false, publicUrl: null, scanIntervalSec: 900 });
    const e = loadConfig({ SYNCLET_TRASH_RETENTION_DAYS: '', SYNCLET_SEARCH_LANGUAGE: '', SYNCLET_WORKER_CONCURRENCY: '', SYNCLET_PREVIEW_MAX_BYTES: '' });
    expect(e).toMatchObject({ trashRetentionDays: 30, searchLanguage: 'simple', workerConcurrency: 2, previewMaxBytes: 2 * 1024 ** 3, role: 'server' });
    expect(loadConfig({ SYNCLET_PUBLIC_URL: 'https://x.example', SYNCLET_SECURE_COOKIES: '' }).secureCookies).toBe(true);
  });

  it('reads explicit values', () => {
    const c = loadConfig({ SYNCLET_MASS_DELETE_THRESHOLD: '0', SYNCLET_TOMBSTONE_WINDOW: '60', SYNCLET_JOURNAL_RETENTION_DAYS: '7', SYNCLET_SECURE_COOKIES: 'off', SYNCLET_PUBLIC_URL: 'https://x.example' });
    expect(c).toMatchObject({ massDeleteThreshold: 0, tombstoneWindowSec: 60, journalRetentionDays: 7, secureCookies: false });
  });

  it('reads phase 1b values', () => {
    const c = loadConfig({ SYNCLET_TRASH_RETENTION_DAYS: '0', SYNCLET_SEARCH_LANGUAGE: 'german', SYNCLET_WORKER_CONCURRENCY: '4', SYNCLET_PREVIEW_MAX_BYTES: '1024' });
    expect(c).toMatchObject({ trashRetentionDays: 0, searchLanguage: 'german', workerConcurrency: 4, previewMaxBytes: 1024 });
  });

  it('trustProxy defaults to false and reads SYNCLET_TRUST_PROXY', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ SYNCLET_TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ SYNCLET_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('phase 1c defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      versions: false, versionsMaxBytes: 0, officeUrl: null, officeJwtSecret: null,
      officeApiUrl: 'http://server:3000/api', officeInternalUrl: 'http://office', ssoEmergency: false, ssoAllowHttpIssuer: false,
    });
    expect(loadConfig({ SYNCLET_SSO_ALLOW_HTTP_ISSUER: '1' }).ssoAllowHttpIssuer).toBe(true);
  });

  it('reads phase 1c variables; empty means default', () => {
    const c = loadConfig({
      SYNCLET_VERSIONS: 'on', SYNCLET_VERSIONS_MAX_BYTES: '1000', OFFICE_URL: 'https://office.example.com',
      OFFICE_JWT_SECRET: 's', OFFICE_API_URL: 'http://srv/api', OFFICE_INTERNAL_URL: 'http://ds', SYNCLET_SSO_EMERGENCY: '1',
    });
    expect(c).toMatchObject({
      versions: true, versionsMaxBytes: 1000, officeUrl: 'https://office.example.com', officeJwtSecret: 's',
      officeApiUrl: 'http://srv/api', officeInternalUrl: 'http://ds', ssoEmergency: true,
    });
    const e = loadConfig({ SYNCLET_VERSIONS: '', OFFICE_URL: '', OFFICE_API_URL: '', SYNCLET_SSO_EMERGENCY: '' });
    expect(e).toMatchObject({ versions: false, officeUrl: null, officeApiUrl: 'http://server:3000/api', ssoEmergency: false });
  });

  it('OFFICE_URL: only with OFFICE_JWT_SECRET, normalized, absolute http(s) required', () => {
    // compose always passes a default URL below SYNCLET_PUBLIC_URL; without the secret office stays off.
    expect(loadConfig({ OFFICE_URL: 'https://files.example.com/documentserver' }).officeUrl).toBeNull();
    expect(loadConfig({ OFFICE_URL: '/documentserver', OFFICE_JWT_SECRET: '' }).officeUrl).toBeNull();
    const url = (v: string) => loadConfig({ OFFICE_URL: v, OFFICE_JWT_SECRET: 's' }).officeUrl;
    expect(url('https://files.example.com/documentserver')).toBe('https://files.example.com/documentserver');
    expect(url('https://files.example.com//documentserver/')).toBe('https://files.example.com/documentserver');
    expect(url('http://localhost:8080/documentserver')).toBe('http://localhost:8080/documentserver');
    expect(url('https://office.example.com/')).toBe('https://office.example.com');
    // SYNCLET_PUBLIC_URL unset: compose passes just "/documentserver".
    for (const bad of ['/documentserver', 'office.example.com', 'ftp://x/y', 'https://u:p@x/y', 'https://x/y?a=1']) {
      expect(() => url(bad)).toThrow(/OFFICE_URL must be an absolute http\(s\) URL/);
    }
  });

  it('SYNCLET_SSO_EMERGENCY accepts the usual boolean spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes']) expect(loadConfig({ SYNCLET_SSO_EMERGENCY: v }).ssoEmergency).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', '']) expect(loadConfig({ SYNCLET_SSO_EMERGENCY: v }).ssoEmergency).toBe(false);
  });

  it('SYNCLET_MAX_UPLOAD_BYTES must be a plain byte count (like the bundled Caddy needs it)', () => {
    expect(loadConfig({ SYNCLET_MAX_UPLOAD_BYTES: '1048576' }).maxUploadBytes).toBe(1048576);
    expect(loadConfig({ SYNCLET_MAX_UPLOAD_BYTES: '' }).maxUploadBytes).toBe(50 * 1024 ** 3);
    for (const v of ['50G', '1e9', '10 MB', '-1', ' 5', 'abc']) {
      expect(() => loadConfig({ SYNCLET_MAX_UPLOAD_BYTES: v })).toThrow(/SYNCLET_MAX_UPLOAD_BYTES must be a plain number of bytes/);
    }
  });

  it('SYNCLET_EVENTS_PING_SECONDS: default 25 s, at least 1 s', () => {
    expect(loadConfig({}).eventsPingSeconds).toBe(25);
    expect(loadConfig({ SYNCLET_EVENTS_PING_SECONDS: '' }).eventsPingSeconds).toBe(25);
    expect(loadConfig({ SYNCLET_EVENTS_PING_SECONDS: '5' }).eventsPingSeconds).toBe(5);
    expect(loadConfig({ SYNCLET_EVENTS_PING_SECONDS: 'x' }).eventsPingSeconds).toBe(25);
    expect(loadConfig({ SYNCLET_EVENTS_PING_SECONDS: '0' }).eventsPingSeconds).toBe(1);
    expect(loadConfig({ SYNCLET_EVENTS_PING_SECONDS: '-3' }).eventsPingSeconds).toBe(1);
  });
  it('build version, revision and update check', () => {
    expect(loadConfig({})).toMatchObject({ buildVersion: 'dev', buildRevision: null, updateCheck: true, updateRepo: 'eltomato89/synclet' });
    expect(loadConfig({ SYNCLET_BUILD_VERSION: '', SYNCLET_BUILD_REVISION: '', SYNCLET_UPDATE_CHECK: '', SYNCLET_UPDATE_REPO: '' }))
      .toMatchObject({ buildVersion: 'dev', buildRevision: null, updateCheck: true, updateRepo: 'eltomato89/synclet' });
    expect(loadConfig({ SYNCLET_BUILD_VERSION: '1.2.3', SYNCLET_BUILD_REVISION: 'abc', SYNCLET_UPDATE_CHECK: 'off', SYNCLET_UPDATE_REPO: 'me/synclet-fork' }))
      .toMatchObject({ buildVersion: '1.2.3', buildRevision: 'abc', updateCheck: false, updateRepo: 'me/synclet-fork' });
    expect(() => loadConfig({ SYNCLET_UPDATE_REPO: 'https://github.com/x/y' })).toThrow(/owner\/repo/);
    // Surrounding whitespace (e.g. "off " in .env) is ignored by every on/off setting.
    expect(loadConfig({ SYNCLET_UPDATE_CHECK: ' off ', SYNCLET_VERSIONS: ' on\t' })).toMatchObject({ updateCheck: false, versions: true });
    expect(loadConfig({ SYNCLET_UPDATE_CHECK: '   ' }).updateCheck).toBe(true);
  });
});
