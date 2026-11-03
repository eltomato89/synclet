using System.Reflection;
using System.Runtime.InteropServices;

namespace Synclet.Sync.Linux.Fuse.Native;

/// <summary>P/Invoke declarations for libfuse3's low-level API.</summary>
internal static unsafe partial class LibFuse
{
    /// <summary>Logical name; <see cref="Resolve"/> maps it to the installed SONAME.</summary>
    private const string Lib = "libfuse3";
    private const string LibC = "libc.so.6";

    /// <summary>libfuse 3.17 bumped the SONAME to .so.4 with the same symbols; older 3.x use .so.3.</summary>
    private static readonly string[] Candidates = ["libfuse3.so.4", "libfuse3.so.3"];

    private static readonly Lazy<(nint Handle, string Name)> Library = new(() =>
    {
        foreach (var name in Candidates)
            if (NativeLibrary.TryLoad(name, out var handle)) return (handle, name);
        throw new DllNotFoundException($"libfuse3 not found (tried {string.Join(", ", Candidates)}); install fuse3");
    });

    private static readonly delegate* unmanaged<FuseArgs*, FuseLowlevelOps*, nuint, nint, nint> SessionNew = ResolveSessionNew();

    /// <summary>The SONAME that was loaded.</summary>
    public static string LoadedLibrary => Library.Value.Name;

    /// <summary>
    /// An explicit static constructor runs before any member of this class, so every libfuse import below goes
    /// through <see cref="Resolve"/>. Only this class imports libfuse.
    /// </summary>
    static LibFuse() => NativeLibrary.SetDllImportResolver(typeof(LibFuse).Assembly, Resolve);

    private static nint Resolve(string name, Assembly assembly, DllImportSearchPath? path) =>
        name == Lib ? Library.Value.Handle : 0;

    /// <summary>
    /// libfuse 3.17 added <c>fuse_session_new_versioned</c>; the FUSE_3.0 version of <c>fuse_session_new</c>
    /// exists in every 3.x release and keeps the original signature.
    /// </summary>
    private static delegate* unmanaged<FuseArgs*, FuseLowlevelOps*, nuint, nint, nint> ResolveSessionNew()
    {
        var handle = Library.Value.Handle;
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
