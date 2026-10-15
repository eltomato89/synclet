import { describe, expect, it } from 'vitest';
import type { PublicShareInfo } from '@synclet/shared';
import { PublicError } from './api';
import { gateReducer, type GateState, initialGate } from './gate';

const info: PublicShareInfo = {
  id: 'd_1', name: 'Urlaub', type: 'folder', size: 10, mime: null, ownerDisplayName: 'Jens', allowDownload: true, allowUpload: false, expiresAt: null,
};
const err = (status: number, code: string, retryAfter: number | null = null) => new PublicError(status, code, code, retryAfter);
const NOW = 1_000_000;
const locked: GateState = { status: 'locked', unlocking: false, error: null, retryAt: null, relock: false };

describe('gateReducer', () => {
  it('opens when the info arrives', () => {
    expect(gateReducer(initialGate, { type: 'loaded', info })).toEqual({ status: 'open', info });
  });

  it('asks for the password on 401 share_password_required', () => {
    expect(gateReducer(initialGate, { type: 'failed', error: err(401, 'share_password_required'), now: NOW })).toEqual(locked);
  });

  it('runs the unlock flow: unlocking → wrong password → unlocking → unlocked → loading', () => {
    let s = gateReducer(locked, { type: 'unlock' });
    expect(s).toMatchObject({ status: 'locked', unlocking: true, error: null });
    s = gateReducer(s, { type: 'unlockFailed', error: err(401, 'unauthorized'), now: NOW });
    expect(s).toMatchObject({ status: 'locked', unlocking: false, error: 'wrong_password' });
    s = gateReducer(s, { type: 'unlock' });
    expect(s).toMatchObject({ unlocking: true, error: null });
    expect(gateReducer(s, { type: 'unlocked' })).toEqual({ status: 'loading' });
  });

  it('reports the unlock rate limit with its retry time', () => {
    const s = gateReducer({ ...locked, unlocking: true }, { type: 'unlockFailed', error: err(429, 'rate_limited', 10), now: NOW });
    expect(s).toMatchObject({ status: 'locked', error: 'rate_limited', retryAt: NOW + 10_000 });
  });

  it('treats 404 and 410 as gone from any state', () => {
    for (const state of [initialGate, locked, { status: 'open', info } as GateState]) {
      expect(gateReducer(state, { type: 'failed', error: err(404, 'not_found'), now: NOW })).toEqual({ status: 'gone', reason: 'not_found' });
      expect(gateReducer(state, { type: 'failed', error: err(410, 'share_expired'), now: NOW })).toEqual({ status: 'gone', reason: 'expired' });
    }
    expect(gateReducer(locked, { type: 'unlockFailed', error: err(410, 'share_expired'), now: NOW })).toEqual({ status: 'gone', reason: 'expired' });
  });

  it('locks again (relock) when the unlock runs out while browsing', () => {
    const s = gateReducer({ status: 'open', info }, { type: 'failed', error: err(401, 'share_password_required'), now: NOW });
    expect(s).toEqual({ ...locked, relock: true });
  });

  it('keeps the content open on transient errors while browsing', () => {
    const open: GateState = { status: 'open', info };
    expect(gateReducer(open, { type: 'failed', error: err(0, 'network'), now: NOW })).toBe(open);
  });

  it('fails with a retry on network errors, 429 and 503 while loading, and retries into loading', () => {
    expect(gateReducer(initialGate, { type: 'failed', error: err(0, 'network'), now: NOW })).toEqual({ status: 'failed', error: 'network', retryAt: null });
    expect(gateReducer(initialGate, { type: 'failed', error: err(429, 'rate_limited', 1), now: NOW }))
      .toEqual({ status: 'failed', error: 'rate_limited', retryAt: NOW + 1000 });
    const busy = gateReducer(initialGate, { type: 'failed', error: err(503, 'busy', 30), now: NOW });
    expect(busy).toEqual({ status: 'failed', error: 'busy', retryAt: NOW + 30_000 });
    expect(gateReducer(busy, { type: 'retry' })).toEqual({ status: 'loading' });
  });

  it('ignores unlock events outside the gate', () => {
    const open: GateState = { status: 'open', info };
    expect(gateReducer(open, { type: 'unlock' })).toBe(open);
    expect(gateReducer(open, { type: 'unlockFailed', error: err(401, 'unauthorized'), now: NOW })).toBe(open);
  });
});
