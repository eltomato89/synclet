# Single sign-on

Synclet supports two kinds of SSO, configured by an admin in the web app (admin area, "Single sign-on"); the settings are stored in the database (the OIDC client secret is encrypted).

- **OpenID Connect (OIDC):** a "Sign in with ..." button on the login page. Works with Authentik, Keycloak, Authelia and any other standards-compliant IdP.
- **Forward-auth:** a trusted reverse proxy in front of Synclet authenticates users and passes the identity in headers (Authelia, Authentik proxy outpost, ...).

Both can be enabled at the same time as password login.

## OIDC

1. Set `SYNCLET_PUBLIC_URL` (e.g. `https://files.example.com`); OIDC cannot be enabled without it. The **redirect URI** to register at the IdP is:

   ```
   ${SYNCLET_PUBLIC_URL}/api/auth/oidc/callback
   ```

2. Create a **confidential** OIDC client at the IdP (authorization code flow; Synclet always uses PKCE `S256`, `state` and `nonce`) and note the issuer URL, client ID and client secret.
3. In Synclet: admin area > Single sign-on > OIDC: issuer, client ID, client secret, then "Test" (runs OIDC discovery) and enable. The issuer must be `https://` (an `http://` issuer on a loopback/private host only with `SYNCLET_SSO_ALLOW_HTTP_ISSUER=1`, for lab setups).

Settings (defaults in brackets):

| Setting | Meaning |
| --- | --- |
| Scopes (`openid profile email`) | Must include `openid`. Add `groups` if your IdP needs that scope to release the groups claim. |
| Username claim (`preferred_username`) | Claim for the new user's name (dotted paths such as `realm_access.roles` work for nested claims). |
| Groups claim (`groups`) | Claim with the group list (array or single string; dotted paths allowed). |
| Allowed groups | If set, only members of at least one of these groups may sign in (checked on **every** login). Empty = every user the IdP authenticates. |
| Admin groups | If set, members become admins, and the role follows the membership on every login (the last enabled admin with a password is never demoted). Empty = SSO users are regular users, roles are managed in the admin area. |
| Link by email (off) | See below. |
| Button label | Text of the login button. |

Claims are read from the ID token and, if the IdP has a userinfo endpoint, supplemented from there.

**Authentik.** Create an OAuth2/OpenID Provider (client type *Confidential*, redirect URI mode *Strict* with the URI above, a signing key selected) and an Application using it. Issuer: `https://authentik.example.com/application/o/<application-slug>/`. The default `profile` scope mapping already provides `groups`. Create a group such as `synclet-admins` and enter it as admin group.

**Keycloak.** In your realm create a client (*Client authentication* on, *Standard flow* on, valid redirect URI as above). Issuer: `https://keycloak.example.com/realms/<realm>`. Keycloak has no groups claim by default: under *Client scopes* > `<client>-dedicated` > *Add mapper* > *Group Membership*, claim name `groups`, **Full group path off**, add to ID token and userinfo. Alternatively set the groups claim to `realm_access.roles` and use realm roles.

**Authelia.** Add a client to `identity_providers.oidc.clients` in Authelia's configuration (secret as digest, plain secret in Synclet):

```yaml
- client_id: synclet
  client_name: Synclet
  client_secret: '$pbkdf2-sha512$...'   # authelia crypto hash generate pbkdf2
  public: false
  authorization_policy: two_factor
  require_pkce: true
  pkce_challenge_method: S256
  redirect_uris:
    - https://files.example.com/api/auth/oidc/callback
  scopes: [openid, profile, email, groups]
  token_endpoint_auth_method: client_secret_basic
```

Issuer: the Authelia root URL, e.g. `https://auth.example.com`. Put `groups` into the scopes in Synclet as well (`openid profile email groups`). Synclet reads the ID token and also the userinfo endpoint (ID-token claims win, userinfo fills what is missing), so groups released only via userinfo work too. Authelia 4.39 and later releases some claims only through a `claims_policy` on the client; if groups don't arrive, add a policy that includes `groups` (and `email`) for the ID token.

## Accounts created and linked by SSO

- **Auto-provisioning.** The first login of an unknown identity creates a user (no setup by an admin). The username comes from the username claim and is sanitized to a safe folder name (forbidden characters become `-`, at most 64 characters, reserved names and empty results become `user`). If the name is taken (case-insensitive) or a folder of that name already exists in `SYNCLET_DATA`, a suffix is added (`alice-2`, `alice-3`, ...): an SSO login **never adopts an existing folder**. A verified email address is stored when nobody else uses it.
- **Link by email (off by default).** Without this option an OIDC login never attaches to an existing local account, even if the email address matches. When an admin turns it on, an unknown identity is linked to the existing user with the same email address **only if the IdP marks the email as verified** (`email_verified: true`). Only enable it if your IdP verifies email addresses (a user who can set an arbitrary unverified email at the IdP could otherwise take over accounts). Forward-auth never links by email.
- **Disabled users** cannot sign in via SSO either.
- **Password login for regular users** can be turned off in the SSO settings. **Admins can always use their password**, so a broken IdP never locks out the instance.

## Forward-auth (Authelia, Authentik, ...)

The proxy authenticates the visitor and forwards identity headers; the web app then signs the user in automatically (`POST /api/auth/forward`). Default header names (changeable in the admin area): `Remote-User` (username), `Remote-Email`, `Remote-Name`, `Remote-Groups` (comma or `|` separated). Authelia sends exactly these; for Authentik's outpost set the names to `X-authentik-username`, `X-authentik-email`, `X-authentik-name` and `X-authentik-groups`. Allowed/admin groups and provisioning work as for OIDC (but never link by email).

Two layers decide who may assert an identity, and **both must be configured**:

1. **Caddy** removes the identity headers from every `/api/*` request whose direct peer is not in `SYNCLET_FORWARD_AUTH_PROXIES`. Set it to the **exact address of your authenticating proxy** only, e.g. `192.168.1.10/32` (or its fixed address on a Docker network shared with Caddy). **Never use `private_ranges` or a whole subnet:** every host in it (any device in your LAN, any container on the host, and with Docker's userland proxy even outside clients that appear as the gateway address) could then send `Remote-User: <admin>` and sign in as that user. Empty (the default) means nothing is trusted and the headers are always stripped. This variable is independent of `SYNCLET_TRUSTED_PROXIES`, which only governs `X-Forwarded-For`. **If you configure custom header names, add them to the `request_header @untrusted_auth_headers -<Name>` lines of the Caddyfile** (they are not stripped otherwise): copy [`deploy/Caddyfile`](../deploy/Caddyfile), add the lines and mount your copy over the built-in one in a `compose.override.yml` (`services: caddy: volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]`), or edit `deploy/Caddyfile` in a checkout and rebuild (`compose.build.yml`, `up -d --build`).
2. **The Synclet server** accepts the headers only if its direct TCP peer is inside the *trusted proxies* of the forward-auth settings. In the shipped setup that peer is the Caddy container. Enter **only Caddy's address** there, not the whole Docker network of the stack (that network also holds the worker and the Document Server, which fetches URLs on users' behalf). Give Caddy a fixed address in a `compose.override.yml`, for example:

   ```yaml
   networks:
     default:
       ipam:
         config: [{ subnet: 172.30.0.0/24 }]
   services:
     caddy:
       networks:
         default:
           ipv4_address: 172.30.0.10
   ```

   and enter `172.30.0.10/32` as the forward-auth trusted proxy. Never put the address of any untrusted network there; `X-Forwarded-For` is never used for this decision.
3. **Make the proxy the only way in.** Clients must not be able to reach Caddy directly, bypassing the gate. Publish Caddy's ports on loopback only (`SYNCLET_PORT=127.0.0.1:8080`, `SYNCLET_TLS_PORT=127.0.0.1:8443`) when the outer proxy runs on the same host, reach it only over a Docker network shared with the outer proxy, or block the ports with a firewall.

Outer proxy example with Caddy and Authelia:

```
files.example.com {
	# Everything that authenticates itself (Synclet tokens, share links) or carries no secret
	# (the SPA's static files) bypasses the SSO gate. /documentserver/*: only with Office (the
	# Document Server checks its own JWTs).
	@open path /api/sync/* /api/auth/app/* /api/public/* /s/* /assets/* /favicon.svg /index.html /documentserver/*
	handle @open {
		reverse_proxy synclet-caddy:80
	}
	handle {
		forward_auth authelia:9091 {
			uri /api/authz/forward-auth
			copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
		}
		reverse_proxy synclet-caddy:80
	}
}
```

For Authentik use its outpost instead: add `handle /outpost.goauthentik.io/* { reverse_proxy authentik-outpost:9000 }` before the other blocks, and `forward_auth authentik-outpost:9000 { uri /outpost.goauthentik.io/auth/caddy; copy_headers X-authentik-username X-authentik-email X-authentik-name X-authentik-groups }` (with the matching header names in the Synclet settings and in `deploy/Caddyfile`).

Why these paths bypass: `/s/<token>` is a route of the single-page app, so anonymous visitors of a public share link get the app shell (`index.html`, `/assets/*`, `/favicon.svg`) and then call `/api/public/*`; without the static files the share page does not load. Native apps and sync clients send Synclet tokens to `/api/sync/*` and sign in through `/api/auth/app/*`. **Tradeoff:** the bypass of `/api/auth/app/*` exposes the (rate-limited) password authorize endpoint outside the SSO gate. If you don't want password sign-in reachable that way, turn off password login for users in the SSO settings (admins keep it, by design); the apps then sign in through the browser with an existing SSO session. The `Remote-*` headers are only needed on the web login entry: what must stay behind the gate is `/`, `/login` and `/api/auth/forward`, not the API (the web app also calls `/api/sync/v1/*` with Synclet tokens, which authenticate themselves). The gate must **not** wrap `/documentserver/*` (or the office subdomain): the Document Server loads in an iframe, uses WebSockets and fetches files from Synclet with its own tokens.

nginx and Traefik work the same way with `auth_request` / the `forwardAuth` middleware; copy the four headers to the upstream request. Put the proxy's exact address into `SYNCLET_FORWARD_AUTH_PROXIES` (and `SYNCLET_TRUSTED_PROXIES` for the client IP), enter Caddy's address in the forward-auth trusted proxies as described, and keep the bypass list above.

## Locked out? Emergency recovery

- Set `SYNCLET_SSO_EMERGENCY=1` in `.env` and run `docker compose ... up -d`. OIDC and forward-auth are ignored and **password login is allowed for everyone**. Fix the SSO settings, then remove the variable again.
- If no admin has a working password, give one a new password (this also enables the account, makes it admin and signs out its sessions):

  ```bash
  docker compose exec server node dist/cli/reset-admin-password.js <username>
  # or choose the password yourself:
  echo 'a new password' | docker compose exec -T server node dist/cli/reset-admin-password.js <username>
  ```

  Without a password on stdin a random one is generated and printed (10-200 characters otherwise).
