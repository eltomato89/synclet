/**
 * Native apps allowed to sign in through the browser flow (OAuth 2.0 Authorization Code + PKCE).
 * Public clients without a secret: protection comes from PKCE and exactly matched redirect URIs (RFC 8252).
 */
export interface AppClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** Loopback redirect with any port (desktop apps without a URL scheme). */
  loopback?: boolean;
}

const APP_CALLBACK = 'synclet://oauth';

export const APP_CLIENTS: Record<string, AppClient> = {
  ios: { id: 'ios', name: 'Synclet for iPhone and iPad', redirectUris: [APP_CALLBACK] },
  android: { id: 'android', name: 'Synclet for Android', redirectUris: [APP_CALLBACK] },
  macos: { id: 'macos', name: 'Synclet for Mac', redirectUris: [APP_CALLBACK] },
  windows: { id: 'windows', name: 'Synclet for Windows', redirectUris: [], loopback: true },
  linux: { id: 'linux', name: 'Synclet for Linux', redirectUris: [], loopback: true },
};

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/;

/** Returns the client when `clientId` is known and `redirectUri` matches it exactly. */
export function resolveAppClient(clientId: string, redirectUri: string): AppClient | null {
  const client = Object.prototype.hasOwnProperty.call(APP_CLIENTS, clientId) ? APP_CLIENTS[clientId] : undefined;
  if (!client) return null;
  if (client.redirectUris.includes(redirectUri)) return client;
  if (client.loopback) {
    const m = LOOPBACK.exec(redirectUri);
    if (m && Number(m[1]) > 0 && Number(m[1]) <= 65535) return client;
  }
  return null;
}
