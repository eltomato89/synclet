# Known limitations and security notes

## Known limitations

- **macOS (Docker Desktop):** renames and moves made in Finder or other host apps show up inside the container with new inode numbers. Synclet then sees a delete plus a create instead of a move: the item gets a new ID and clients download it again. Linux hosts keep IDs across host-side renames and moves.
- **NFS/SMB sources** do not deliver change events reliably (inotify on the mount only sees changes made through this host, not on the NAS itself), and setting up the watcher on a big share can take very long: set the space to **Watch for changes: Off (scan only)**, or `SYNCLET_WATCH=off` for all spaces, to scan periodically instead. Inode numbers may not be stable there either, so item IDs may change when files are moved externally.
- **Deletes on the host bypass the trash.** Only deletes made through Synclet go to the trash in `SYNCLET_META`. A file you delete on the host is gone, and the delete is synced to all clients.
- inotify: on large folders raise `fs.inotify.max_user_watches` (for example `sysctl fs.inotify.max_user_watches=524288`).

## Security notes

- Resetting a user's password (or disabling the user) in the admin API signs out all of that user's **web sessions**. **Sync devices are not revoked** by a password reset, by design: devices are revoked explicitly in the device list (`DELETE /api/sync/v1/devices/<id>`). If you suspect a device token was stolen, revoke the device as well. Disabling a user blocks all of their device tokens.
- **Preview tokens.** To show thumbnails, images, video and PDFs in the browser, the web app gets short-lived URLs with a `?dt=` token that is bound to one item and valid for **6 hours** (download links: 60 seconds). These tokens are not tied to a session: they **keep working after logout and after a password reset** until they expire. Disabling the user blocks them immediately.
- **"Allow download" off is not copy protection.** When a share link has downloads disabled, recipients cannot download files or the folder as ZIP, but they can still **view images, video, audio, text and PDFs inline in the browser**, and the browser can save what it displays.
- **Share links follow their item into the trash and back.** Moving a shared item (or a folder containing it) to the trash does not revoke its links: they answer "not found" while the item is in the trash, and **restoring the item re-activates them** with all their settings (password, expiry, uploads). The Shared page lists these links with an "In trash" badge so you can revoke them. Links of items deleted for good stop working permanently.
