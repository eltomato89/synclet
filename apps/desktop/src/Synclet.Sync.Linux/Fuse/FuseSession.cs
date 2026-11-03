using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Synclet.Sync.Linux.Fuse.Native;

namespace Synclet.Sync.Linux.Fuse;

public sealed record FuseOptions(TimeSpan EntryTimeout, TimeSpan AttrTimeout, string FsName = "synclet");

/// <summary>
/// One mounted libfuse session with its own loop thread.
/// <para>
/// Shutdown order (all native teardown happens on the loop thread, as libfuse expects): the loop returns once the
/// file system is unmounted (by <see cref="Stop"/> or externally) or the connection is aborted → wait until every
/// asynchronous reply has been sent → <c>fuse_session_unmount</c> (closes the device fd) → <see cref="Dispose"/>
/// destroys the session. Replies are never sent after the fd is closed or the session is freed.
/// </para>
/// </summary>
public sealed unsafe class FuseSession : IDisposable
{
    private static readonly TimeSpan DrainTimeout = TimeSpan.FromSeconds(30);

    private readonly FuseLowlevelOps* _ops;
    private readonly GCHandle _dispatcherHandle;
    private readonly FuseDispatcher _dispatcher;
    private readonly object _lock = new();
    private readonly ManualResetEventSlim _exited = new();
    private nint _session;
    private Thread? _loop;
    private bool _drained = true;
    private int _stopped;
    private bool _disposed;

    public string MountPoint { get; }

    /// <summary>Requests whose reply is still pending (asynchronous file system calls).</summary>
    public int InFlight => _dispatcher.InFlight;

    private FuseSession(string mountPoint, FuseLowlevelOps* ops, GCHandle handle, FuseDispatcher dispatcher, nint session)
    {
        MountPoint = mountPoint;
        _ops = ops;
        _dispatcherHandle = handle;
        _dispatcher = dispatcher;
        _session = session;
    }

    public static FuseSession Mount(string mountPoint, IFuseFileSystem fs, FuseOptions options)
    {
        mountPoint = Path.GetFullPath(mountPoint);
        Fusermount("-uz", mountPoint);
        Directory.CreateDirectory(mountPoint);

        var ops = (FuseLowlevelOps*)NativeMemory.AllocZeroed((nuint)sizeof(FuseLowlevelOps));
        FuseDispatcher.Fill(ops);
        var dispatcher = new FuseDispatcher(fs, options);
        var handle = GCHandle.Alloc(dispatcher);

        string[] argv = ["synclet", "-o", $"fsname={options.FsName},subtype={options.FsName}"];
        var strings = argv.Select(a => Marshal.StringToCoTaskMemUTF8(a)).ToArray();
        var argvPtr = (nint*)NativeMemory.Alloc((nuint)(sizeof(nint) * (argv.Length + 1)));
        try
        {
            for (var i = 0; i < strings.Length; i++) argvPtr[i] = strings[i];
            argvPtr[argv.Length] = 0;
            var args = new FuseArgs { Argc = argv.Length, Argv = (nint)argvPtr, Allocated = 0 };
            var se = LibFuse.fuse_session_new(&args, ops, (nuint)sizeof(FuseLowlevelOps), GCHandle.ToIntPtr(handle));
            if (se == 0) throw new InvalidOperationException("fuse_session_new failed (see stderr)");
            if (LibFuse.fuse_session_mount(se, mountPoint) != 0)
            {
                LibFuse.fuse_session_destroy(se);
                throw new InvalidOperationException($"mounting {mountPoint} failed (see stderr)");
            }
            return new FuseSession(mountPoint, ops, handle, dispatcher, se);
        }
        catch
        {
            handle.Free();
            NativeMemory.Free(ops);
            throw;
        }
        finally
        {
            foreach (var s in strings) Marshal.FreeCoTaskMem(s);
            NativeMemory.Free(argvPtr);
        }
    }

    /// <summary>Starts processing requests on a dedicated thread.</summary>
    public void Start()
    {
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_loop is not null) throw new InvalidOperationException("already started");
            _loop = new Thread(Loop) { Name = "fuse-loop", IsBackground = true };
            _loop.Start();
        }
    }

    /// <summary>Blocks until the loop has ended (unmounted and drained).</summary>
    public bool WaitForExit(TimeSpan timeout) => _exited.Wait(timeout);

    /// <summary>Asks the loop to end by lazily unmounting; returns immediately.</summary>
    public void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        lock (_lock)
        {
            if (_session == 0) return;
            LibFuse.fuse_session_exit(_session);
        }
        // An external unmount ends the kernel connection once no file is open any more, which wakes the loop.
        Fusermount("-uz", MountPoint);
    }

    /// <summary>Drops the kernel's cached lookup of <paramref name="name"/> in <paramref name="parent"/>.</summary>
    public void InvalidateEntry(ulong parent, string name)
    {
        var bytes = Encoding.UTF8.GetBytes(name.Normalize(NormalizationForm.FormC));
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            fixed (byte* p = bytes) LibFuse.fuse_lowlevel_notify_inval_entry(_session, parent, p, (nuint)bytes.Length);
        }
    }

    /// <summary>Drops cached attributes and data of <paramref name="ino"/>.</summary>
    public void InvalidateInode(ulong ino)
    {
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            LibFuse.fuse_lowlevel_notify_inval_inode(_session, ino, 0, 0);
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
        }
        Stop();
        if (_loop is null)
        {
            LibFuse.fuse_session_unmount(_session);
            _exited.Set();
        }
        else
        {
            _loop.Join();
        }

        lock (_lock)
        {
            if (!_drained)
            {
                // A reply may still arrive; freeing the session now would let it write into freed memory.
                Console.Error.WriteLine($"synclet-fuse: {InFlight} replies still pending, leaking the session of {MountPoint}");
                return;
            }
            LibFuse.fuse_session_destroy(_session);
            _session = 0;
        }
        _dispatcherHandle.Free();
        NativeMemory.Free(_ops);
    }

    private void Loop()
    {
        try
        {
            LibFuse.fuse_session_loop(_session);
            _drained = SpinWait.SpinUntil(() => InFlight == 0, DrainTimeout);
            if (_drained) LibFuse.fuse_session_unmount(_session);
        }
        finally
        {
            _exited.Set();
        }
    }

    private static void Fusermount(string flags, string mountPoint)
    {
        try
        {
            var psi = new ProcessStartInfo("fusermount3") { RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var a in new[] { flags, mountPoint }) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            p?.WaitForExit(5000);
        }
        catch (Exception)
        {
            // fusermount3 missing or nothing mounted: nothing to do.
        }
    }
}
