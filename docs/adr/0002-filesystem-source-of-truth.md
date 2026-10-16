# ADR 0002: The file system is the source of truth

- Status: accepted (2026-10-15)

## Context
Users should be able to point Synclet at an existing folder and throw the container away at any time. What the web app and the apps show must lie 1:1 on disk.

## Decision
- The data folder (`/data/<username>/`) contains only user files – no metadata files, no xattrs, no hidden folders. The only exception is short-lived temp files `.<name>.synclet-<id>` during an atomic write; they are ignored and cleaned up at startup.
- All metadata (item index, journal, thumbnails, trash, versions, search index) lives in PostgreSQL or in the `/meta` volume.
- The server detects external changes with a watcher (`@parcel/watcher`, best effort) and a periodic reconcile scan.
- Stable item IDs: path match before inode match before delete+create.

## Consequences
- External deletions cannot go to the trash, and external edits cannot be versioned.
- On network file systems with unstable inodes, external moves degrade to delete+create.
- Without an optional same-FS mode, trash and versions cost a copy (EXDEV).
