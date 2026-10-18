# Versions

Optional and **off by default** (`SYNCLET_VERSIONS=off`). When on, Synclet keeps the previous content of a file whenever it is overwritten **through Synclet** (web upload/replace, sync clients, Office saves, restoring a version).

**Enable.** Set `SYNCLET_VERSIONS=on` in `deploy/.env` and run `docker compose ... up -d`. The web app then shows a version list per file (download, restore). With versions off the version endpoints answer `404 versions disabled` and the web hides the UI. Optionally cap the space with `SYNCLET_VERSIONS_MAX_BYTES` (per user, default `0` = unlimited).

**Where.** Versions are stored in `SYNCLET_META/versions/<user>/<item>/`, **never in `SYNCLET_DATA`**. They follow the item: moving or renaming a file keeps its versions, they stay while the file is in the trash and are removed with it (delete forever, emptying the trash, expiry). Restoring a version first turns the current content into a version, so nothing is lost.

**Retention.** The daily maintenance run thins versions out like Nextcloud does. The newest version is always kept; going back in time, at most one version is kept per step:

| Age of the version | Kept at most |
| --- | --- |
| up to 10 seconds | one per 2 seconds |
| up to 1 minute | one per 10 seconds |
| up to 1 hour | one per minute |
| up to 24 hours | one per hour |
| up to 30 days | one per day |
| older | one per week (kept until the file is gone or `SYNCLET_VERSIONS_MAX_BYTES` evicts it) |

With `SYNCLET_VERSIONS_MAX_BYTES` set, the oldest versions of a user are deleted first when the cap is exceeded; the newest version of each file is never evicted by the cap.

**Limitations.**

- Only overwrites made through Synclet create versions. Changes made directly on the host (editor, `cp`, ...) are picked up by the indexer but not versioned.
- Versions need disk space in `SYNCLET_META` (the admin status page shows it). On the same file system Synclet uses a hard link when possible, otherwise a copy.
- Switching versions off stops creating new ones; existing versions stay on disk but are neither served nor cleaned up until you switch it on again.
