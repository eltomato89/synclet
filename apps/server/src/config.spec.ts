import { loadConfig } from './config';

describe('loadConfig', () => {
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
      officeApiUrl: 'http://server:3000/api', officeInternalUrl: 'http://office', ssoEmergency: false,
    });
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
});
