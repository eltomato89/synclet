using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using Synclet.Sync.Linux.Fuse.Native;

namespace Synclet.Sync.Linux.Fuse;

/// <summary>
/// Turns libfuse low-level callbacks into <see cref="IFuseFileSystem"/> calls. Callbacks copy their arguments,
/// start the task and return; the reply is sent when the task completes (possibly on a thread-pool thread), so a
/// slow request never blocks the session loop. Exceptions never cross into native code.
/// </summary>
internal sealed unsafe class FuseDispatcher(IFuseFileSystem fs, FuseOptions options)
{
    private const uint SIfDir = 0x4000, SIfReg = 0x8000;
    private const int OAccMode = 3, OTrunc = 0x200;
    private const int SetAttrSize = 1 << 3, SetAttrMtime = 1 << 5, SetAttrMtimeNow = 1 << 8;

    private int _inFlight;
    private readonly uint _uid = LibFuse.getuid();
    private readonly uint _gid = LibFuse.getgid();

    public IFuseFileSystem Fs { get; } = fs;

    public int InFlight => Volatile.Read(ref _inFlight);

    public static void Fill(FuseLowlevelOps* ops)
    {
        ops->Lookup = (nint)(delegate* unmanaged<nint, ulong, byte*, void>)&OnLookup;
        ops->Getattr = (nint)(delegate* unmanaged<nint, ulong, FuseFileInfo*, void>)&OnGetattr;
        ops->Setattr = (nint)(delegate* unmanaged<nint, ulong, byte*, int, FuseFileInfo*, void>)&OnSetattr;
        ops->Mkdir = (nint)(delegate* unmanaged<nint, ulong, byte*, uint, void>)&OnMkdir;
        ops->Unlink = (nint)(delegate* unmanaged<nint, ulong, byte*, void>)&OnUnlink;
        ops->Rmdir = (nint)(delegate* unmanaged<nint, ulong, byte*, void>)&OnRmdir;
        ops->Rename = (nint)(delegate* unmanaged<nint, ulong, byte*, ulong, byte*, uint, void>)&OnRename;
        ops->Open = (nint)(delegate* unmanaged<nint, ulong, FuseFileInfo*, void>)&OnOpen;
        ops->Read = (nint)(delegate* unmanaged<nint, ulong, nuint, long, FuseFileInfo*, void>)&OnRead;
        ops->Write = (nint)(delegate* unmanaged<nint, ulong, byte*, nuint, long, FuseFileInfo*, void>)&OnWrite;
        ops->Release = (nint)(delegate* unmanaged<nint, ulong, FuseFileInfo*, void>)&OnRelease;
        ops->Readdir = (nint)(delegate* unmanaged<nint, ulong, nuint, long, FuseFileInfo*, void>)&OnReaddir;
        ops->Statfs = (nint)(delegate* unmanaged<nint, ulong, void>)&OnStatfs;
        ops->Create = (nint)(delegate* unmanaged<nint, ulong, byte*, uint, FuseFileInfo*, void>)&OnCreate;
    }

    // ---- callbacks -------------------------------------------------------------------------------------------

    [UnmanagedCallersOnly]
    private static void OnLookup(nint req, ulong parent, byte* name) => Guard(req, d =>
    {
        var n = Name(name);
        d.Reply(req, () => d.Fs.Lookup(parent, n), a => d.ReplyEntry(req, a));
    });

    [UnmanagedCallersOnly]
    private static void OnGetattr(nint req, ulong ino, FuseFileInfo* fi) => Guard(req, d =>
        d.Reply(req, () => d.Fs.GetAttr(ino), a => d.ReplyAttr(req, a)));

    [UnmanagedCallersOnly]
    private static void OnSetattr(nint req, ulong ino, byte* attr, int toSet, FuseFileInfo* fi) => Guard(req, d =>
    {
        var stat = StatWriter.Read(attr);
        long? size = (toSet & SetAttrSize) != 0 ? stat.Size : null;
        DateTimeOffset? mtime = (toSet & SetAttrMtimeNow) != 0 ? DateTimeOffset.UtcNow
            : (toSet & SetAttrMtime) != 0 ? FromUnix(stat.MTimeSec, stat.MTimeNsec) : null;
        Trace($"setattr ino={ino} to_set=0x{toSet:x} size={size}");
        d.Reply(req, () => d.Fs.SetAttr(ino, size, mtime), a => d.ReplyAttr(req, a));
    });

    [UnmanagedCallersOnly]
    private static void OnMkdir(nint req, ulong parent, byte* name, uint mode) => Guard(req, d =>
    {
        var n = Name(name);
        d.Reply(req, () => d.Fs.MkDir(parent, n), a => d.ReplyEntry(req, a));
    });

    [UnmanagedCallersOnly]
    private static void OnUnlink(nint req, ulong parent, byte* name) => Guard(req, d =>
    {
        var n = Name(name);
        Trace($"unlink parent={parent} {n}");
        d.ReplyDone(req, () => d.Fs.Unlink(parent, n));
    });

    [UnmanagedCallersOnly]
    private static void OnRmdir(nint req, ulong parent, byte* name) => Guard(req, d =>
    {
        var n = Name(name);
        d.ReplyDone(req, () => d.Fs.RmDir(parent, n));
    });

    [UnmanagedCallersOnly]
    private static void OnRename(nint req, ulong parent, byte* name, ulong newParent, byte* newName, uint flags) => Guard(req, d =>
    {
        if (flags != 0)
        {
            LibFuse.fuse_reply_err(req, Errno.EINVAL);
            return;
        }
        var (from, to) = (Name(name), Name(newName));
        Trace($"rename {parent}/{from} -> {newParent}/{to}");
        d.ReplyDone(req, () => d.Fs.Rename(parent, from, newParent, to));
    });

    [UnmanagedCallersOnly]
    private static void OnOpen(nint req, ulong ino, FuseFileInfo* fi) => Guard(req, d =>
    {
        var flags = fi->Flags;
        var write = (flags & OAccMode) != 0;
        var truncate = (flags & OTrunc) != 0;
        Trace($"open ino={ino} flags=0x{flags:x}");
        d.Reply(req, () => d.Fs.Open(ino, write, truncate), fh => ReplyOpen(req, flags, fh));
    });

    [UnmanagedCallersOnly]
    private static void OnRead(nint req, ulong ino, nuint size, long off, FuseFileInfo* fi) => Guard(req, d =>
    {
        var fh = fi->Fh;
        d.Reply(req, () => d.Fs.Read(ino, fh, off, (int)size), data =>
        {
            fixed (byte* p = data.Span) LibFuse.fuse_reply_buf(req, p, (nuint)data.Length);
        });
    });

    [UnmanagedCallersOnly]
    private static void OnWrite(nint req, ulong ino, byte* buf, nuint size, long off, FuseFileInfo* fi) => Guard(req, d =>
    {
        var fh = fi->Fh;
        var data = new ReadOnlySpan<byte>(buf, (int)size).ToArray();
        Trace($"write ino={ino} off={off} len={size}");
        d.Reply(req, () => d.Fs.Write(ino, fh, off, data), n => LibFuse.fuse_reply_write(req, (nuint)n));
    });

    [UnmanagedCallersOnly]
    private static void OnRelease(nint req, ulong ino, FuseFileInfo* fi) => Guard(req, d =>
    {
        var fh = fi->Fh;
        Trace($"release ino={ino}");
        d.ReplyDone(req, () => d.Fs.Release(ino, fh));
    });

    [UnmanagedCallersOnly]
    private static void OnReaddir(nint req, ulong ino, nuint size, long off, FuseFileInfo* fi) => Guard(req, d =>
        d.Reply(req, () => d.Fs.ReadDir(ino), entries => d.ReplyDir(req, ino, entries, (int)size, off)));

    [UnmanagedCallersOnly]
    private static void OnStatfs(nint req, ulong ino) => Guard(req, d =>
        d.Reply(req, () => d.Fs.StatFs(), stats =>
        {
            const ulong block = 4096;
            var vfs = new StatVfs
            {
                Bsize = block, Frsize = block,
                Blocks = (ulong)stats.TotalBytes / block,
                Bfree = (ulong)stats.FreeBytes / block, Bavail = (ulong)stats.FreeBytes / block,
                Files = 1_000_000, Ffree = 1_000_000, Favail = 1_000_000, Namemax = 255,
            };
            LibFuse.fuse_reply_statfs(req, &vfs);
        }));

    [UnmanagedCallersOnly]
    private static void OnCreate(nint req, ulong parent, byte* name, uint mode, FuseFileInfo* fi) => Guard(req, d =>
    {
        var n = Name(name);
        Trace($"create parent={parent} {n} flags=0x{fi->Flags:x}");
        var flags = fi->Flags;
        d.Reply(req, () => d.Fs.Create(parent, n), r => d.ReplyCreate(req, r.Attr, flags, r.Fh));
    });

    // ---- replies ---------------------------------------------------------------------------------------------

    private void ReplyEntry(nint req, NodeAttr a)
    {
        var e = stackalloc byte[EntryParamWriter.Size];
        EntryParamWriter.Write(e, a.Ino, 0, ToStat(a), options.AttrTimeout.TotalSeconds, options.EntryTimeout.TotalSeconds);
        LibFuse.fuse_reply_entry(req, e);
    }

    private void ReplyAttr(nint req, NodeAttr a)
    {
        var s = stackalloc byte[StatWriter.Size];
        StatWriter.Write(s, ToStat(a));
        LibFuse.fuse_reply_attr(req, s, options.AttrTimeout.TotalSeconds);
    }

    private static void ReplyOpen(nint req, int flags, ulong fh)
    {
        var info = new FuseFileInfo { Flags = flags, Fh = fh };
        LibFuse.fuse_reply_open(req, &info);
    }

    private void ReplyCreate(nint req, NodeAttr a, int flags, ulong fh)
    {
        var info = new FuseFileInfo { Flags = flags, Fh = fh };
        var e = stackalloc byte[EntryParamWriter.Size];
        EntryParamWriter.Write(e, a.Ino, 0, ToStat(a), options.AttrTimeout.TotalSeconds, options.EntryTimeout.TotalSeconds);
        LibFuse.fuse_reply_create(req, e, &info);
    }

    /// <summary>Entry i of [".", "..", children…] carries offset i + 1; a call resumes after <paramref name="off"/>.</summary>
    private void ReplyDir(nint req, ulong ino, IReadOnlyList<DirEntry> entries, int size, long off)
    {
        var all = new List<(string Name, ulong Ino, bool IsDir)> { (".", ino, true), ("..", ino, true) };
        all.AddRange(entries.Select(e => (e.Name, e.Attr.Ino, e.Attr.IsDir)));
        var buffer = new byte[size];
        var stat = stackalloc byte[StatWriter.Size];
        nuint used = 0;
        fixed (byte* buf = buffer)
        {
            for (var i = (int)off; i < all.Count; i++)
            {
                var (name, entryIno, isDir) = all[i];
                var nameBytes = Encoding.UTF8.GetBytes(name + '\0');
                StatWriter.Write(stat, new StatData(entryIno, isDir ? SIfDir : SIfReg, 1, 0, 0, 0, 0, 0, 0, 0));
                fixed (byte* n = nameBytes)
                {
                    var needed = LibFuse.fuse_add_direntry(req, null, 0, n, null, 0);
                    if (used + needed > (nuint)size) break;
                    used += LibFuse.fuse_add_direntry(req, buf + used, (nuint)size - used, n, stat, i + 1);
                }
            }
            LibFuse.fuse_reply_buf(req, buf, used);
        }
    }

    private StatData ToStat(NodeAttr a)
    {
        var perms = a.IsDir ? (a.ReadOnly ? 0x16Du : 0x1EDu) : (a.ReadOnly ? 0x124u : 0x1A4u); // 0555/0755, 0444/0644
        var ticks = a.MTime.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks;
        return new StatData(
            Ino: a.Ino, Mode: (a.IsDir ? SIfDir : SIfReg) | perms, Nlink: a.IsDir ? 2u : 1u, Uid: _uid, Gid: _gid,
            Size: a.Size, Blocks: (a.Size + 511) / 512, BlkSize: 4096,
            MTimeSec: ticks / TimeSpan.TicksPerSecond, MTimeNsec: ticks % TimeSpan.TicksPerSecond * 100);
    }

    // ---- plumbing --------------------------------------------------------------------------------------------

    private static DateTimeOffset FromUnix(long sec, long nsec) =>
        DateTimeOffset.UnixEpoch.AddTicks(sec * TimeSpan.TicksPerSecond + nsec / 100);

    /// <summary>SYNCLET_FUSE_TRACE=1 logs mutating operations to stderr (diagnosing editor save sequences).</summary>
    private static readonly bool Tracing = Environment.GetEnvironmentVariable("SYNCLET_FUSE_TRACE") == "1";

    private static void Trace(string message)
    {
        if (Tracing) Console.Error.WriteLine($"trace {message}");
    }

    private static string Name(byte* name) =>
        Marshal.PtrToStringUTF8((nint)name)!.Normalize(NormalizationForm.FormC);

    private static void Guard(nint req, Action<FuseDispatcher> body)
    {
        try
        {
            var d = (FuseDispatcher)GCHandle.FromIntPtr(LibFuse.fuse_req_userdata(req)).Target!;
            body(d);
        }
        catch (Exception e)
        {
            ReplyError(req, e);
        }
    }

    /// <summary>Starts the call; a reply that cannot be sent synchronously counts as in flight until sent.</summary>
    private void Reply<T>(nint req, Func<Task<T>> start, Action<T> onSuccess)
    {
        var task = start();
        if (task.IsCompleted)
        {
            Complete(req, task, onSuccess);
            return;
        }
        Interlocked.Increment(ref _inFlight);
        task.ContinueWith(t =>
        {
            try { Complete(req, t, onSuccess); }
            finally { Interlocked.Decrement(ref _inFlight); }
        }, TaskScheduler.Default);
    }

    private void ReplyDone(nint req, Func<Task> start)
    {
        var task = start();
        if (task.IsCompleted)
        {
            CompleteDone(req, task);
            return;
        }
        Interlocked.Increment(ref _inFlight);
        task.ContinueWith(t =>
        {
            try { CompleteDone(req, t); }
            finally { Interlocked.Decrement(ref _inFlight); }
        }, TaskScheduler.Default);
    }

    private static void CompleteDone(nint req, Task task)
    {
        if (task.IsCompletedSuccessfully) LibFuse.fuse_reply_err(req, 0);
        else ReplyError(req, task.Exception?.InnerException ?? new TaskCanceledException());
    }

    private static void Complete<T>(nint req, Task<T> task, Action<T> onSuccess)
    {
        if (!task.IsCompletedSuccessfully)
        {
            ReplyError(req, task.Exception?.InnerException ?? new TaskCanceledException());
            return;
        }
        try
        {
            onSuccess(task.Result);
        }
        catch (Exception e)
        {
            // The reply may not have been sent; answering twice is worse than logging.
            Log(e);
        }
    }

    private static void ReplyError(nint req, Exception e)
    {
        if (e is FuseException fe)
        {
            LibFuse.fuse_reply_err(req, fe.Errno);
            return;
        }
        Log(e);
        LibFuse.fuse_reply_err(req, Errno.EIO);
    }

    private static void Log(Exception e, [CallerMemberName] string caller = "") =>
        Console.Error.WriteLine($"synclet-fuse: {caller}: {e}");
}
