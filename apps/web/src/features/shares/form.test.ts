import { describe, expect, it } from 'vitest';
import { createPayload, expiryDate, initialValues, patchPayload, type ShareFormContext, type ShareFormValues, toDateInput, validateShareForm } from './form';

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime(); // local time, 15 Oct 2026 noon
const v = (patch: Partial<ShareFormValues> = {}): ShareFormValues => ({ ...initialValues(), ...patch });
const NEW: ShareFormContext = { isFolder: false, expiryTouched: false };

describe('validateShareForm', () => {
  it('accepts the defaults', () => {
    expect(validateShareForm(v(), NEW, NOW)).toEqual({});
  });

  it('requires at least 6 password characters when the password is on', () => {
    expect(validateShareForm(v({ passwordOn: true }), NEW, NOW)).toEqual({ password: 'required' });
    expect(validateShareForm(v({ passwordOn: true, password: '12345' }), NEW, NOW)).toEqual({ password: 'too_short' });
    expect(validateShareForm(v({ passwordOn: true, password: '123456' }), NEW, NOW)).toEqual({});
    expect(validateShareForm(v({ passwordOn: false, password: '1' }), NEW, NOW)).toEqual({});
  });

  it('lets an edited link keep its password with an empty field', () => {
    const ctx: ShareFormContext = { isFolder: false, expiryTouched: false, existing: { hasPassword: true, expiresAt: null, allowDownload: true, allowUpload: false } };
    expect(validateShareForm(v({ passwordOn: true }), ctx, NOW)).toEqual({});
    expect(validateShareForm(v({ passwordOn: true, password: 'abc' }), ctx, NOW)).toEqual({ password: 'too_short' });
  });

  it('rejects custom dates in the past and missing dates, accepts today', () => {
    expect(validateShareForm(v({ expiry: 'custom', customDate: '2026-10-14' }), NEW, NOW)).toEqual({ expiry: 'past' });
    expect(validateShareForm(v({ expiry: 'custom', customDate: '' }), NEW, NOW)).toEqual({ expiry: 'required' });
    expect(validateShareForm(v({ expiry: 'custom', customDate: '2026-02-30' }), NEW, NOW)).toEqual({ expiry: 'required' });
    expect(validateShareForm(v({ expiry: 'custom', customDate: '2026-10-15' }), NEW, NOW)).toEqual({});
  });

  it('ignores an untouched past expiry of an existing link, but checks it once changed', () => {
    const existing = { hasPassword: false, expiresAt: new Date(2026, 9, 1).toISOString(), allowDownload: true, allowUpload: false };
    const values = initialValues(existing);
    expect(values).toMatchObject({ expiry: 'custom', customDate: '2026-10-01' });
    expect(validateShareForm(values, { isFolder: false, expiryTouched: false, existing }, NOW)).toEqual({});
    expect(validateShareForm(values, { isFolder: false, expiryTouched: true, existing }, NOW)).toEqual({ expiry: 'past' });
  });
});

describe('payloads', () => {
  it('turns presets and custom dates into future timestamps', () => {
    // Presets end with the local day like picked dates: 15 Oct + 7 = 22 Oct, 23:59:59.999.
    expect(expiryDate(v({ expiry: '7d' }), NOW)?.getTime()).toBe(new Date(2026, 9, 22, 23, 59, 59, 999).getTime());
    expect(expiryDate(v({ expiry: '1d' }), NOW)?.getTime()).toBe(new Date(2026, 9, 16, 23, 59, 59, 999).getTime());
    expect(toDateInput(expiryDate(v({ expiry: '30d' }), NOW)!)).toBe('2026-11-14');
    expect(expiryDate(v({ expiry: 'none' }), NOW)).toBeNull();
    const end = expiryDate(v({ expiry: 'custom', customDate: '2026-10-20' }), NOW)!;
    expect(toDateInput(end)).toBe('2026-10-20');
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  });

  it('only sends allowUpload for folders', () => {
    expect(createPayload('f_1', v({ allowUpload: true }), NEW, NOW)).toEqual({ itemId: 'f_1', password: null, expiresAt: null, allowDownload: true });
    expect(createPayload('d_1', v({ passwordOn: true, password: 'secret1', allowUpload: true }), { ...NEW, isFolder: true }, NOW))
      .toEqual({ itemId: 'd_1', password: 'secret1', expiresAt: null, allowDownload: true, allowUpload: true });
  });

  it('patches only what changed', () => {
    const existing = { hasPassword: true, expiresAt: null, allowDownload: true, allowUpload: false };
    const ctx = { isFolder: true, expiryTouched: false, existing };
    expect(patchPayload(initialValues(existing), ctx, NOW)).toEqual({});
    expect(patchPayload({ ...initialValues(existing), passwordOn: false }, ctx, NOW)).toEqual({ password: null });
    expect(patchPayload({ ...initialValues(existing), password: 'newpass', allowUpload: true }, ctx, NOW)).toEqual({ password: 'newpass', allowUpload: true });
    expect(patchPayload({ ...initialValues(existing), expiry: '1d' }, { ...ctx, expiryTouched: true }, NOW))
      .toEqual({ expiresAt: new Date(2026, 9, 16, 23, 59, 59, 999).toISOString() });
  });
});
