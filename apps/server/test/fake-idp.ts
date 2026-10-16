import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importEsm } from '../src/common/import-esm';

/**
 * Minimal in-process OpenID Provider for tests: discovery, JWKS, an auto-approving authorize
 * endpoint (claims from `nextClaims`), a token endpoint (client_secret_basic, PKCE S256) issuing
 * RS256 id_tokens signed with `jose`, and userinfo.
 */
export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Claims (incl. `sub`) of the user who "logs in" at the next authorize request. */
  nextClaims: Record<string, unknown>;
  /** Tampering for negative tests: id_token `iss`/`nonce`/`aud` overrides. */
  tamper: { iss?: string; nonce?: string; aud?: string };
  /** Claims served only by userinfo (not in the id_token). */
  userinfoOnly: Record<string, unknown>;
  /** Number of discovery requests served. */
  discoveries: number;
  close(): Promise<void>;
}

interface CodeGrant { claims: Record<string, unknown>; nonce?: string; challenge: string; redirectUri: string; clientId: string }

const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s));
});

export async function startFakeIdp(): Promise<FakeIdp> {
  const jose = await importEsm<typeof import('jose')>('jose');
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, CodeGrant>();
  const accessTokens = new Map<string, Record<string, unknown>>();

  const idp: FakeIdp = {
    issuer: '', clientId: 'synclet', clientSecret: 'top-secret', nextClaims: {}, tamper: {}, userinfoOnly: {}, discoveries: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const json = (res: import('node:http').ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      idp.discoveries++;
      return json(res, 200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        userinfo_endpoint: `${idp.issuer}/userinfo`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== idp.clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256') {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        claims: { ...idp.nextClaims }, nonce: p.get('nonce') ?? undefined, challenge: p.get('code_challenge')!,
        redirectUri: p.get('redirect_uri')!, clientId: p.get('client_id')!,
      });
      const target = new URL(p.get('redirect_uri')!);
      target.searchParams.set('code', code);
      if (p.get('state')) target.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: target.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      const [id, secret] = basic.split(':').map(decodeURIComponent);
      if (id !== idp.clientId || secret !== idp.clientSecret) return json(res, 401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!grant || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== grant.redirectUri) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
      const accessToken = randomBytes(16).toString('hex');
      accessTokens.set(accessToken, { ...grant.claims, ...idp.userinfoOnly });
      const nonce = idp.tamper.nonce ?? grant.nonce;
      const idToken = await new jose.SignJWT({ ...grant.claims, ...(nonce ? { nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idp.tamper.iss ?? idp.issuer)
        .setAudience(idp.tamper.aud ?? grant.clientId)
        .setSubject(String(grant.claims.sub))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === '/userinfo') {
      const claims = accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!claims) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, claims);
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return idp;
}
