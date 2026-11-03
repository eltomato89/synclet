# Synclet desktop clients (Linux, Windows)

Work in progress. The Linux client will show your Synclet files and spaces as an on-demand file system
(FUSE), the Windows client through the Cloud Files API. Both share one .NET 10 core.
See [ADR 0003](../../docs/adr/0003-desktop-clients.md).

## Layout

| Path | Contents |
| --- | --- |
| `src/Synclet.Sync.Linux` | libfuse3 low-level binding (P/Invoke): structures, session, dispatcher, `IFuseFileSystem` |
| `spike/Synclet.FuseSpike` | Mounts an in-memory tree through that binding; used to prove the approach |
| `tests/Synclet.Sync.Linux.Tests` | Struct layouts against the C headers, in-memory tree, real mounts |
| `scripts/` | `linux.sh` (build/test container with `/dev/fuse`), `smoke.sh`, `distro-smoke.sh` |

## Build and test

You need Docker; no local .NET is required. Everything runs in `mcr.microsoft.com/dotnet/sdk:10.0` with FUSE:

```bash
apps/desktop/scripts/linux.sh dotnet test                                  # native architecture
SYNCLET_PLATFORM=linux/amd64 apps/desktop/scripts/linux.sh dotnet test     # x64 under emulation
```

Tests use Microsoft.Testing.Platform (`global.json`), so filters look like `dotnet test --filter-class '*MountTests'`.

## Try the spike

```bash
apps/desktop/scripts/linux.sh dotnet publish spike/Synclet.FuseSpike -c Release -r linux-x64 \
  --self-contained -p:PublishSingleFile=true -o out/linux-x64
# on a Linux machine with fuse3 and libicu:
./Synclet.FuseSpike ~/SyncletSpike          # Ctrl+C unmounts
./smoke.sh ~/SyncletSpike                   # in a second terminal
```

The mount shows `Meine Dateien` (writable) and `Team Foto` (read-only). `langsam.bin` answers every read after
2 s (`--read-delay-ms`). Commands on stdin, tab-separated: `add-remote <path> <text>`, `version <path>`, `id <path>`,
`quit`. `SYNCLET_FUSE_TRACE=1` logs every write-side operation to stderr.

`scripts/distro-smoke.sh ubuntu:24.04|fedora:41|debian:trixie` runs the published binary and the smoke test in a
clean container.
