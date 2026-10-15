import { loadConfig } from './config';

describe('loadConfig', () => {
  it('treats empty values (compose `${VAR:-}`) as unset', () => {
    const c = loadConfig({
      SYNCLET_MASS_DELETE_THRESHOLD: '', SYNCLET_TOMBSTONE_WINDOW: '', SYNCLET_JOURNAL_RETENTION_DAYS: '',
      SYNCLET_SECURE_COOKIES: '', SYNCLET_PUBLIC_URL: '', SYNCLET_SCAN_INTERVAL: '', SYNCLET_MAX_UPLOAD_BYTES: '',
    });
    expect(c).toMatchObject({ massDeleteThreshold: 25, tombstoneWindowSec: 3600, journalRetentionDays: 30, secureCookies: false, publicUrl: null, scanIntervalSec: 900 });
    expect(loadConfig({ SYNCLET_PUBLIC_URL: 'https://x.example', SYNCLET_SECURE_COOKIES: '' }).secureCookies).toBe(true);
  });

  it('reads explicit values', () => {
    const c = loadConfig({ SYNCLET_MASS_DELETE_THRESHOLD: '0', SYNCLET_TOMBSTONE_WINDOW: '60', SYNCLET_JOURNAL_RETENTION_DAYS: '7', SYNCLET_SECURE_COOKIES: 'off', SYNCLET_PUBLIC_URL: 'https://x.example' });
    expect(c).toMatchObject({ massDeleteThreshold: 0, tombstoneWindowSec: 60, journalRetentionDays: 7, secureCookies: false });
  });
});
