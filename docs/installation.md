# Installing and updating

The short version is in the [README](../README.md#get-started). The details:

## Updating

Image tags: `X.Y.Z` (a release), `X.Y` (the newest patch release of that line), `latest` (the newest release) and `edge` (the latest image build from `main`, untested). Set `SYNCLET_VERSION` in `.env` to the version you want (recommended: a pinned release instead of `latest`), then:

```bash
docker compose pull
docker compose up -d
```

The server migrates the database on start. Downgrading after a migration is not supported, so back up the database before updating if you want a way back. If the release notes say that `compose.yml` changed, download it again (for a pinned release from its tag, e.g. `https://raw.githubusercontent.com/eltomato89/synclet/v1.2.3/deploy/compose.yml`).

**With Office on its own subdomain (`compose.office.yml`):** the office container moved into `compose.yml`. Download the new `compose.office.yml` together with the new `compose.yml` (a new `compose.yml` with the old `compose.office.yml` fails with "depends on undefined service office"), or switch to the default `/documentserver` setup; see [Upgrading from the subdomain-only setup](office.md#office-euro-office-editing).

## Building from source

To build the images yourself from a checkout, add `deploy/compose.build.yml`. It builds both images and tags them locally (`synclet/server:dev`, `synclet/caddy:dev`), so they never overwrite pulled images:

```bash
git clone https://github.com/eltomato89/synclet.git && cd synclet
cp deploy/.env.example deploy/.env
# edit deploy/.env as above (the default SYNCLET_TEAMS=./teams is deploy/teams in the checkout)
docker compose -f deploy/compose.yml -f deploy/compose.build.yml --env-file deploy/.env up -d --build
```

To update a source build, pull the repository (`git pull`) and run the same command again. In a checkout every `docker compose` command below needs these `-f`/`--env-file` options.
