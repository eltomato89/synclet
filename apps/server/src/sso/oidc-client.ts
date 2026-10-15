import type * as Oidc from 'openid-client';
import { importEsm } from '../common/import-esm';
import { isPrivateHost } from './net';

export type OidcLib = typeof import('openid-client');
export type OidcConfiguration = Oidc.Configuration;

let lib: Promise<OidcLib> | undefined;
/** openid-client is ESM-only; loaded once through the dynamic-import helper. */
export function oidcLib(): Promise<OidcLib> {
  lib ??= importEsm<OidcLib>('openid-client');
  return lib;
}

/**
 * Checks an issuer URL: https, or http only when `allowHttp` (SYNCLET_SSO_ALLOW_HTTP_ISSUER=1) is
 * set and the host is loopback/private. Returns an error message or null.
 */
export async function issuerProblem(issuer: string, allowHttp: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'issuer must be an absolute URL';
  }
  if (url.username || url.password || url.search || url.hash) return 'issuer must not contain credentials, query or fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'issuer must be an https URL';
  if (!allowHttp) return 'issuer must be an https URL (http only for private hosts with SYNCLET_SSO_ALLOW_HTTP_ISSUER=1)';
  if (!(await isPrivateHost(url.hostname))) return 'http issuers are only allowed for localhost/private hosts';
  return null;
}

export interface OidcClientParams { issuer: string; clientId: string; clientSecret: string | null }

/**
 * OIDC discovery (issuer metadata, validated against `issuer`) and client configuration.
 * Insecure (http) requests are enabled only for issuers that passed `issuerProblem` with allowHttp.
 */
export async function discoverOidc(params: OidcClientParams, allowHttp: boolean): Promise<OidcConfiguration> {
  const problem = await issuerProblem(params.issuer, allowHttp);
  if (problem) throw new Error(problem);
  const client = await oidcLib();
  const insecure = new URL(params.issuer).protocol === 'http:';
  const options: Oidc.DiscoveryRequestOptions = { timeout: 10, ...(insecure ? { execute: [client.allowInsecureRequests] } : {}) };
  // Discover first without client auth to pick the token endpoint auth method the IdP supports.
  const probe = await client.discovery(new URL(params.issuer), params.clientId, undefined, client.None(), options);
  if (!params.clientSecret) return probe;
  const methods = probe.serverMetadata().token_endpoint_auth_methods_supported;
  const auth = !methods || methods.includes('client_secret_basic') || !methods.includes('client_secret_post')
    ? client.ClientSecretBasic(params.clientSecret)
    : client.ClientSecretPost(params.clientSecret);
  const config = new client.Configuration(probe.serverMetadata(), params.clientId, undefined, auth);
  config.timeout = 10;
  if (insecure) client.allowInsecureRequests(config);
  return config;
}
