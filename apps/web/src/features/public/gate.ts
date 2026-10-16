import type { PublicShareInfo } from '@synclet/shared';
import { PublicError } from './api';

/**
 * State machine of the share page, from opening the link to showing its content.
 *
 *   loading ── info ──────────────▶ open
 *      │                              │ 401 (unlock expired) ─▶ locked
 *      ├─ 401 password_required ─▶ locked ── unlock ─▶ unlocking ── ok ─▶ loading
 *      │                              ▲                   │
 *      │                              └── wrong / 429 ────┘
 *      ├─ 404 / 410 ──────────────▶ gone (not_found | expired)   (from any state)
 *      └─ 429 / 503 / network ────▶ failed ── retry ─▶ loading
 */
export type GateError = 'wrong_password' | 'rate_limited' | 'busy' | 'network' | 'unknown';

export type GateState =
  | { status: 'loading' }
  | { status: 'locked'; unlocking: boolean; error: GateError | null; retryAt: number | null; relock: boolean }
  | { status: 'open'; info: PublicShareInfo }
  | { status: 'gone'; reason: 'not_found' | 'expired' }
  | { status: 'failed'; error: GateError; retryAt: number | null };

export type GateEvent =
  | { type: 'loaded'; info: PublicShareInfo }
  /** Any failed request of the page (info, listing, preview metadata). */
  | { type: 'failed'; error: unknown; now: number }
  | { type: 'unlock' }
  | { type: 'unlockFailed'; error: unknown; now: number }
  | { type: 'unlocked' }
  | { type: 'retry' };

export const initialGate: GateState = { status: 'loading' };

function errorOf(e: unknown): GateError {
  if (!(e instanceof PublicError)) return e instanceof TypeError ? 'network' : 'unknown';
  if (e.code === 'busy') return 'busy';
  if (e.status === 429 || e.code === 'rate_limited') return 'rate_limited';
  if (e.code === 'network') return 'network';
  return 'unknown';
}

function retryAtOf(e: unknown, now: number): number | null {
  return e instanceof PublicError && e.retryAfter !== null ? now + e.retryAfter * 1000 : null;
}

/** Errors that end the visit whatever the current state: the link is unknown, revoked or expired. */
function goneReason(e: unknown): 'not_found' | 'expired' | null {
  if (!(e instanceof PublicError)) return null;
  if (e.status === 410 || e.code === 'share_expired') return 'expired';
  if (e.status === 404) return 'not_found';
  return null;
}

const isPasswordRequired = (e: unknown) => e instanceof PublicError && e.status === 401 && e.code === 'share_password_required';

export function gateReducer(state: GateState, ev: GateEvent): GateState {
  switch (ev.type) {
    case 'loaded':
      return { status: 'open', info: ev.info };
    case 'retry':
    case 'unlocked':
      return { status: 'loading' };
    case 'unlock':
      if (state.status !== 'locked') return state;
      return { ...state, unlocking: true, error: null };
    case 'failed': {
      const gone = goneReason(ev.error);
      if (gone) return { status: 'gone', reason: gone };
      if (isPasswordRequired(ev.error)) {
        // From `open`, the unlock cookie ran out (12 h) or the owner changed the password.
        return { status: 'locked', unlocking: false, error: null, retryAt: null, relock: state.status === 'open' };
      }
      // While content is shown, a failing listing is reported in place, not by leaving the page.
      if (state.status === 'open') return state;
      return { status: 'failed', error: errorOf(ev.error), retryAt: retryAtOf(ev.error, ev.now) };
    }
    case 'unlockFailed': {
      const gone = goneReason(ev.error);
      if (gone) return { status: 'gone', reason: gone };
      if (state.status !== 'locked') return state;
      const wrong = ev.error instanceof PublicError && ev.error.status === 401;
      return {
        ...state, unlocking: false,
        error: wrong ? 'wrong_password' : errorOf(ev.error),
        retryAt: wrong ? null : retryAtOf(ev.error, ev.now),
      };
    }
  }
}
