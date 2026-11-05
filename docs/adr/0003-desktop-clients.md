# ADR 0003: Desktop clients for Linux and Windows

- Status: accepted (2026-11-03)

## Context
Synclet has a Mac client (File Provider), iOS and Android. Linux and Windows users should see their files and every
space they can access in the file manager, on demand like on the Mac: everything is listed, content loads when a
file is opened, folders can be kept offline. Linux has no placeholder API like File Provider or Cloud Files.

## Decision
- One shared core in C# on **.NET 10 (LTS)** for both platforms: API client, state database, transfers, conflicts.
- **Linux:** a virtual file system through **libfuse3's low-level API**, bound with our own thin P/Invoke layer
  (no third-party binding). Inodes map to server items; requests are answered asynchronously so a slow download
  never blocks the file system. A `systemd --user` daemon owns the mounts; the UI talks to it over D-Bus.
- **Windows:** the Cloud Files API (placeholders, hydration on open, "Always keep on this device").
- **UI:** one Avalonia app for both platforms.
- The binding supports libfuse 3.14 to 3.18: it loads `libfuse3.so.4` (3.17+) or `libfuse3.so.3` and resolves
  `fuse_session_new@FUSE_3.0`; `struct stat` is written per architecture (x64 and arm64 differ).

## Consequences
- A spike (`apps/desktop/spike`) proved the binding on Ubuntu 24.04, Fedora 41, Debian 13 and a CachyOS/GNOME
  desktop (x64, arm64), including editor save patterns, read-only spaces, invalidation and clean unmounts.
- Saving through a temp file and rename changes the inode, as on any local file system. Server identity is
  tracked separately from inodes.
- GNOME treats a FUSE mount as local (`filesystem::remote` is false): Nautilus would download images to build
  thumbnails unless the client provides them.
- Nautilus gets no inotify events from FUSE: an open folder shows remote changes after a reload.
- Moving to the trash is not possible inside the mount; deletes go to the Synclet trash on the server.
- The packages depend on `fuse3` and ICU; no Flatpak/Snap.
