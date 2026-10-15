# @synclet/sync-contract

The Synclet Sync API v1 as a machine-readable description and an executable conformance suite.

- `openapi.yaml` – OpenAPI 3.1 description of the routes native clients use. The normative prose
  contract is [`docs/sync/SYNC_API.md`](../../docs/sync/SYNC_API.md).
- `src/client.ts` – a thin fetch client (waits on `429 Retry-After`).
- `src/schema.ts` – validates response bodies against `components.schemas` of `openapi.yaml`.
  **Strict by default:** for validation every documented object is closed, so a field the server
  sends but the description does not document fails the suite (drift detection between server and
  contract in this repository). The contract itself allows the server to add optional fields; to
  run the suite against a newer server that does, set `SYNCLET_CONTRACT_LENIENT=1`.
- `tests/*.test.ts` – the conformance suite (vitest), run against a live server.

## Running

```bash
# from the repository root, against a running server and an existing account
SYNCLET_URL=http://localhost:8080 SYNCLET_USER=admin SYNCLET_PASSWORD=secret pnpm test:contract

# one file
SYNCLET_URL=… SYNCLET_TOKEN=syd_… pnpm test:contract tests/content.test.ts

# lint the OpenAPI description (Redocly, config in redocly.yaml, per-operation exceptions with
# their justification in .redocly.lint-ignore.yaml)
pnpm --filter @synclet/sync-contract lint:openapi
pnpm --filter @synclet/sync-contract typecheck
```

| Variable | Meaning |
|---|---|
| `SYNCLET_URL` | Server origin, without `/api` (required) |
| `SYNCLET_TOKEN` | A device token (`syd_…`) or a web access token (JWT, valid 15 min) |
| `SYNCLET_USER`, `SYNCLET_PASSWORD` | Password login (also enables the password-based app login test) |
| `SYNCLET_SETUP=1` | On a fresh instance: create the first administrator (`SYNCLET_USER`, default `contract`; `SYNCLET_PASSWORD`, default random). On an instance that is set up already, `SYNCLET_USER`/`SYNCLET_PASSWORD` are used to log in |
| `SYNCLET_CONTRACT_LENIENT=1` | Allow response properties that `openapi.yaml` does not document (default: strict, they fail) |
| `SYNCLET_SKIP_THUMBNAILS=1` | Skip the thumbnail test (no derivatives worker running) |
| `SYNCLET_THUMBNAIL_TIMEOUT_MS` | How long to poll for a thumbnail (default 60000) |

`SYNCLET_TOKEN` takes precedence over `SYNCLET_USER`/`SYNCLET_PASSWORD` for authentication.

## What the suite does to the account

The global setup registers a device (`sync-contract <random>`, platform `linux`, a unique
`installationId`, so no real device is revoked) and creates one top-level folder
`contract-<random>`. All test data lives below that folder. The teardown deletes the folder,
removes its trash entries (and those of items deleted inside it) for good, revokes the device and
logs out the web session the suite's password login opened; the app-login test logs out its
session too. Apart from the user's `lastLoginAt`, nothing else is touched; runs are independent of
each other and can be repeated.

Deliberately **not** exercised, because it would affect the account beyond the suite: re-using a
spent refresh token (revokes all sessions of the user), journal expiry (`410` is only checked with
a cursor ahead of the server), disabling users, password-login settings.

## Conditional tests

- **Versions** run when `GET /sync/v1/capabilities` reports `versions: true`; with versions off
  (or a server without the capabilities route) only the "disabled → 404" behavior is checked.
- **Thumbnails** need the derivatives worker (`node dist/main.worker.js`, or the `worker` service
  of the compose stack). Without it the test fails after the timeout with a hint; set
  `SYNCLET_SKIP_THUMBNAILS=1` to skip it instead.
- **App login:** the password flow needs `SYNCLET_USER`/`SYNCLET_PASSWORD` (or `SYNCLET_SETUP=1`);
  the session flow needs a web access token (password login, setup, or a JWT as `SYNCLET_TOKEN`).

Setup failures: if the global setup fails after it registered its device (e.g. the suite folder
cannot be created), it revokes the device and logs out its session before reporting the error.

## Rate limits

`/api/auth/login`, `/api/setup` and `/api/auth/app/*` are limited per client IP (10 requests, then
one every 6 s). One run uses about 10 of them; the client waits for `Retry-After`, so a second run
right after the first is slower (up to about a minute) but passes.

## Local server for development

```bash
docker compose -f deploy/compose.dev.yml up -d          # Postgres on :5434
docker exec deploy-postgres-1 psql -U synclet -c 'CREATE DATABASE synclet_contract'
cd apps/server && pnpm build
export DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet_contract
export SYNCLET_DATA_ROOT=$(mktemp -d) SYNCLET_META_ROOT=$(mktemp -d) PORT=3190
pnpm prisma migrate deploy
node dist/main.js &  node dist/main.worker.js &
cd ../.. && SYNCLET_URL=http://localhost:3190 SYNCLET_SETUP=1 SYNCLET_USER=contract SYNCLET_PASSWORD=contract-password pnpm test:contract
```
