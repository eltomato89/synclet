# Admin area

Admins get an "Admin" entry in the web app with:

- **Users:** create users, change role (admin/user), disable or delete users, reset passwords, adopt an existing, unassigned folder of `SYNCLET_DATA` as a user's folder. The last enabled admin cannot be demoted, disabled or deleted.
- **Sessions and devices:** per user, list and revoke web sessions and sync devices.
- **Shares:** all share links of all users; revoke any of them.
- **Single sign-on:** the OIDC and forward-auth settings described above, including discovery test and the password-login switch.
- **Folders and storages (Spaces):** create team folders, see external storages, assign users and groups with read or write access, set watch mode and scan interval per space, scan now, hide ("Remove") and restore ("Restore"). Details: [deploy/README.md](../deploy/README.md#team-folders-and-external-storage).
- **Groups:** bundle users to grant access to spaces at once.
- **Status:** version and uptime (with an update hint, see below), file watcher state and last full scan, number of users, free and used space of the data and meta volumes, size of derivatives / trash / versions / uploads in `SYNCLET_META`, thumbnail and text-extraction job queues, whether versions are on and whether the Document Server is reachable.

**Update check.** The status page shows the installed version (baked into the image at build time) and whether a newer release exists on GitHub; if so, "Administration" in the sidebar gets a dot and the status page links the release notes. Release images only: `edge` and source builds show "Development build" (with the commit) and never ask GitHub. The check runs in the background and never delays the page: right after a start the status shows "Checking for updates…" until the first answer arrives (usually seconds). If GitHub is unreachable (no internet access, rate limit), it stays like that and is retried after an hour; a release found earlier keeps being shown meanwhile. The request reveals the server's IP address and version to GitHub; turn the check off with `SYNCLET_UPDATE_CHECK=off`. Updating itself stays manual (see [Updating](installation.md#updating)).
