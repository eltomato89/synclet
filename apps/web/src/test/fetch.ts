import { vi } from 'vitest';

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface FetchCall { method: string; path: string; body: unknown; headers: Record<string, string> }
type Handler = (call: FetchCall) => Response | Promise<Response>;

/**
 * Routes `fetch` by `"METHOD /api/path"` (query string ignored). Unrouted requests answer 404.
 * Returns the recorded calls.
 */
export function routeFetch(routes: Record<string, Handler | Response>) {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: FetchCall = { method, path: url.pathname + url.search, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return json(404, { statusCode: 404, code: 'not_found', message: 'unrouted' });
    return route instanceof Response ? route.clone() : route(call);
  });
  return {
    calls,
    count: (key: string) => calls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === key).length,
  };
}

export const USER = { id: 'u1', username: 'jens', displayName: 'Jens Köhler', email: null, role: 'user' };
export const AUTH = { accessToken: 'tok', user: USER };
export const unauthorized = () => json(401, { statusCode: 401, code: 'unauthorized', message: 'x' });
export const methods = (m: Partial<{ password: boolean; oidc: { enabled: boolean; label: string }; forwardAuth: boolean }> = {}) =>
  json(200, { password: true, oidc: { enabled: false, label: 'Single sign-on' }, forwardAuth: false, emergency: false, ...m });
