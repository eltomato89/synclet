using System.Runtime.InteropServices;

namespace Synclet.Sync.Linux.Fuse.Native;

/// <summary>P/Invoke declarations for libfuse3's low-level API.</summary>
internal static unsafe partial class LibFuse
{
    private const string Lib = "libfuse3.so.3";
    private const string LibC = "libc.so.6";

    private static readonly delegate* unmanaged<FuseArgs*, FuseLowlevelOps*, nuint, nint, nint> SessionNew = ResolveSessionNew();

    /// <summary>
    /// libfuse 3.17 changed the exported default of <c>fuse_session_new</c>; the FUSE_3.0 version exists in
    /// every 3.x release and keeps the original signature.
    /// </summary>
    private static delegate* unmanaged<FuseArgs*, FuseLowlevelOps*, nuint, nint, nint> ResolveSessionNew()
    {
        var handle = NativeLibrary.Load(Lib);
        var symbol = dlvsym(handle, "fuse_session_new", "FUSE_3.0");
        if (symbol == 0) symbol = NativeLibrary.GetExport(handle, "fuse_session_new");
        return (delegate* unmanaged<FuseArgs*, FuseLowlevelOps*, nuint, nint, nint>)symbol;
    }

    public static nint fuse_session_new(FuseArgs* args, FuseLowlevelOps* ops, nuint opSize, nint userdata) =>
        SessionNew(args, ops, opSize, userdata);

    [LibraryImport(LibC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint dlvsym(nint handle, string symbol, string version);

    [LibraryImport(LibC)] public static partial uint getuid();
    [LibraryImport(LibC)] public static partial uint getgid();

    [LibraryImport(Lib, StringMarshalling = StringMarshalling.Utf8)]
    public static partial int fuse_session_mount(nint se, string mountpoint);
    [LibraryImport(Lib)] public static partial int fuse_session_loop(nint se);
    [LibraryImport(Lib)] public static partial void fuse_session_exit(nint se);
    [LibraryImport(Lib)] public static partial void fuse_session_unmount(nint se);
    [LibraryImport(Lib)] public static partial void fuse_session_destroy(nint se);
    [LibraryImport(Lib)] public static partial nint fuse_req_userdata(nint req);

    [LibraryImport(Lib)] public static partial int fuse_reply_err(nint req, int err);
    [LibraryImport(Lib)] public static partial int fuse_reply_entry(nint req, byte* entry);
    [LibraryImport(Lib)] public static partial int fuse_reply_attr(nint req, byte* attr, double timeout);
    [LibraryImport(Lib)] public static partial int fuse_reply_open(nint req, FuseFileInfo* fi);
    [LibraryImport(Lib)] public static partial int fuse_reply_create(nint req, byte* entry, FuseFileInfo* fi);
    [LibraryImport(Lib)] public static partial int fuse_reply_buf(nint req, byte* buf, nuint size);
    [LibraryImport(Lib)] public static partial int fuse_reply_write(nint req, nuint count);
    [LibraryImport(Lib)] public static partial int fuse_reply_statfs(nint req, StatVfs* stbuf);
    [LibraryImport(Lib)] public static partial nuint fuse_add_direntry(nint req, byte* buf, nuint bufsize, byte* name, byte* stbuf, long off);

    [LibraryImport(Lib)] public static partial int fuse_lowlevel_notify_inval_entry(nint se, ulong parent, byte* name, nuint namelen);
    [LibraryImport(Lib)] public static partial int fuse_lowlevel_notify_inval_inode(nint se, ulong ino, long off, long len);
}
