import { UUID } from '../common/ids';

/** API id of the caller's own personal space (its space id is the user id). */
export const PERSONAL_API_ID = 'personal';

/** The API id of `space` as seen by `user`: `personal` for the caller's own personal space, else the space uuid. */
export function apiSpaceId(space: { id: string }, user: { id: string }): string {
  return space.id === user.id ? PERSONAL_API_ID : space.id;
}

/** The space id behind an API space id (`personal` = the caller's personal space); null when malformed. */
export function spaceIdFromApi(user: { id: string }, apiId: string | undefined | null): string | null {
  const raw = (apiId ?? '').trim();
  if (raw === PERSONAL_API_ID) return user.id;
  return UUID.test(raw) ? raw : null;
}
