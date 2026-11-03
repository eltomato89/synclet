using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Synclet.Sync.Linux.Fuse.Native;

namespace Synclet.Sync.Linux.Fuse;

public sealed record FuseOptions(TimeSpan EntryTimeout, TimeSpan AttrTimeout, string FsName = "synclet");

/// <summary>One mounted libfuse session. <see cref="Run"/> blocks until the file system is unmounted.</summary>
public sealed unsafe class FuseSession : IDisposable
{
    private readonly FuseLowlevelOps* _ops;
    private readonly GCHandle _dispatcher;
    private nint _session;
    private int _stopped;

    public string MountPoint { get; }

    private FuseSession(string mountPoint, FuseLowlevelOps* ops, GCHandle dispatcher, nint session)
    {
        MountPoint = mountPoint;
        _ops = ops;
        _dispatcher = dispatcher;
        _session = session;
    }

    public static FuseSession Mount(string mountPoint, IFuseFileSystem fs, FuseOptions options)
    {
        mountPoint = Path.GetFullPath(mountPoint);
        UnmountStale(mountPoint);
        Directory.CreateDirectory(mountPoint);

        var ops = (FuseLowlevelOps*)NativeMemory.AllocZeroed((nuint)sizeof(FuseLowlevelOps));
        FuseDispatcher.Fill(ops);
        var dispatcher = GCHandle.Alloc(new FuseDispatcher(fs, options));

        string[] argv = ["synclet", "-o", $"fsname={options.FsName},subtype={options.FsName}"];
        var strings = argv.Select(a => Marshal.StringToCoTaskMemUTF8(a)).ToArray();
        var argvPtr = (nint*)NativeMemory.Alloc((nuint)(sizeof(nint) * (argv.Length + 1)));
        try
        {
            for (var i = 0; i < strings.Length; i++) argvPtr[i] = strings[i];
            argvPtr[argv.Length] = 0;
            var args = new FuseArgs { Argc = argv.Length, Argv = (nint)argvPtr, Allocated = 0 };
            var se = LibFuse.fuse_session_new(&args, ops, (nuint)sizeof(FuseLowlevelOps), GCHandle.ToIntPtr(dispatcher));
            if (se == 0) throw new InvalidOperationException("fuse_session_new failed (see stderr)");
            if (LibFuse.fuse_session_mount(se, mountPoint) != 0)
            {
                LibFuse.fuse_session_destroy(se);
                throw new InvalidOperationException($"mounting {mountPoint} failed (see stderr)");
            }
            return new FuseSession(mountPoint, ops, dispatcher, se);
        }
        catch
        {
            dispatcher.Free();
            NativeMemory.Free(ops);
            throw;
        }
        finally
        {
            foreach (var s in strings) Marshal.FreeCoTaskMem(s);
            NativeMemory.Free(argvPtr);
        }
    }

    /// <summary>Processes requests until the file system is unmounted (by <see cref="Stop"/> or externally).</summary>
    public void Run() => LibFuse.fuse_session_loop(_session);

    /// <summary>Ends the session loop by (lazily) unmounting.</summary>
    public void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        LibFuse.fuse_session_exit(_session);
        LibFuse.fuse_session_unmount(_session);
    }

    /// <summary>Drops the kernel's cached lookup of <paramref name="name"/> in <paramref name="parent"/>.</summary>
    public void InvalidateEntry(ulong parent, string name)
    {
        var bytes = Encoding.UTF8.GetBytes(name.Normalize(NormalizationForm.FormC));
        fixed (byte* p = bytes) LibFuse.fuse_lowlevel_notify_inval_entry(_session, parent, p, (nuint)bytes.Length);
    }

    /// <summary>Drops cached attributes and data of <paramref name="ino"/>.</summary>
    public void InvalidateInode(ulong ino) => LibFuse.fuse_lowlevel_notify_inval_inode(_session, ino, 0, 0);

    public void Dispose()
    {
        if (_session == 0) return;
        Stop();
        LibFuse.fuse_session_destroy(_session);
        _session = 0;
        _dispatcher.Free();
        NativeMemory.Free(_ops);
    }

    /// <summary>A crashed earlier run leaves "Transport endpoint is not connected"; detach it first.</summary>
    private static void UnmountStale(string mountPoint)
    {
        try
        {
            var psi = new ProcessStartInfo("fusermount3") { RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var a in new[] { "-uz", mountPoint }) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            p?.WaitForExit(5000);
        }
        catch (Exception)
        {
            // fusermount3 missing or nothing mounted: nothing to clean up.
        }
    }
}
