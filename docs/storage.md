# Files and storage

## What is written where

| Location | Content |
| --- | --- |
| `SYNCLET_DATA` (`/data`) | Only your files, plus the transient entries listed below. No hidden dirs, no xattrs, no metadata files. |
| `SYNCLET_META` (`/meta`) | Trash (`/meta/trash/<id>/`), delete intents (`/meta/staging/`), thumbnails and previews (`/meta/derived/`), resumable upload parts (`/meta/uploads/`), file versions when enabled (`/meta/versions/`). |
| PostgreSQL | File index, sync journal, users, devices, shares, extracted text for search. |

### The worker container

The `worker` service runs the same image in the worker role (`SYNCLET_ROLE=worker`). It generates thumbnails, previews and extracted text in the background using `ffmpeg`, `poppler-utils` (`pdftoppm`, `pdftotext`), `heif-convert` and `unzip`. It **reads** your files (`/data` is mounted read-only), **writes** only to `/meta/derived` and the database, and never runs migrations (only `server` does). On `docker compose stop` it gets up to 150 s to finish a running job (video thumbnails can take up to two minutes).

### Disk usage and privacy

- `/meta/derived` holds thumbnails and previews, typically a few percent of the size of your media. It can be deleted at any time; the worker regenerates it (a thumbnail is requeued as soon as it is requested and found missing, the rest in batches by the daily maintenance run, which also runs at every server start).
- `/meta/uploads` holds partial resumable uploads. Abandoned uploads are removed after 24 hours. Nothing appears in `SYNCLET_DATA` until an upload completes.
- Thumbnails and extracted text (used for search) are stored in `/meta` and in the database. When a file is deleted for good (trash expiry or emptying the trash), its derivatives and extracted text are removed by garbage collection.

### What Synclet may write into your folder

Besides the files you upload, rename, move or delete through Synclet, only two kinds of short-lived entries ever appear in a user folder:

- `.synclet-tmp-<id>`: an upload or replacement in progress. It is renamed onto the final name when complete. Leftovers from a crash are removed at the next start.
- `.synclet-trash-<id>`: an item you just deleted, while it is being moved into the trash in `SYNCLET_META`. It disappears when the move finishes. After a crash, the next start completes the move (or puts the item back if the delete never committed).

Both are ignored by the indexer and never synced. These names are reserved: you cannot create files or folders with these prefixes through the app or the sync API. A file you create yourself on the host named `.synclet-tmp-<letters/digits>` directly in a user folder is treated as a crash leftover and removed at startup.

Other names are never indexed or synced either: `.DS_Store`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `.localized`, `Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN`, `@eaDir`, `#recycle`, `lost+found`, AppleDouble files (`._*`), Office lock and temp files (`~$*`, `~WRL*.tmp`, `.~lock.*#`). Symlinks are never followed, including a user folder that is itself a symlink.

### Deleting needs disk space in `SYNCLET_META`

`SYNCLET_DATA` and `SYNCLET_META` are separate mounts, so deleting through Synclet **copies** the item into `SYNCLET_META` and then removes the original. You need free space there equal to the size of what you delete. Trashed items are removed for good after `SYNCLET_TRASH_RETENTION_DAYS` (default 30). The delete itself is answered at once, and the copy runs in the background (you see the `.synclet-trash-<id>` entry in the meantime).
