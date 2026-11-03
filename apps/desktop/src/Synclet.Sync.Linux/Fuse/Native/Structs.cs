using System.Runtime.InteropServices;

namespace Synclet.Sync.Linux.Fuse.Native;

/// <summary><c>struct fuse_file_info</c> (libfuse 3.x, 40 bytes on 64-bit).</summary>
[StructLayout(LayoutKind.Sequential)]
public struct FuseFileInfo
{
    public int Flags;
    /// <summary>Bit field: writepage, direct_io, keep_cache, flush, nonseekable, flock_release, cache_readdir, noflush.</summary>
    public uint Bits;
    public uint Padding2;
    public ulong Fh;
    public ulong LockOwner;
    public uint PollEvents;

    public bool DirectIo { readonly get => (Bits & 0x2) != 0; set => Bits = value ? Bits | 0x2 : Bits & ~0x2u; }
    public bool KeepCache { readonly get => (Bits & 0x4) != 0; set => Bits = value ? Bits | 0x4 : Bits & ~0x4u; }
    public bool Nonseekable { readonly get => (Bits & 0x10) != 0; set => Bits = value ? Bits | 0x10 : Bits & ~0x10u; }
}

/// <summary><c>struct fuse_lowlevel_ops</c> up to and including <c>lseek</c>, in header order.</summary>
[StructLayout(LayoutKind.Sequential)]
public struct FuseLowlevelOps
{
    public nint Init, Destroy, Lookup, Forget, Getattr, Setattr, Readlink, Mknod, Mkdir, Unlink, Rmdir, Symlink,
        Rename, Link, Open, Read, Write, Flush, Release, Fsync, Opendir, Readdir, Releasedir, Fsyncdir, Statfs,
        Setxattr, Getxattr, Listxattr, Removexattr, Access, Create, Getlk, Setlk, Bmap, Ioctl, Poll, WriteBuf,
        RetrieveReply, ForgetMulti, Flock, Fallocate, Readdirplus, CopyFileRange, Lseek;
}

/// <summary><c>struct fuse_args</c>.</summary>
[StructLayout(LayoutKind.Sequential)]
public struct FuseArgs
{
    public int Argc;
    public nint Argv;
    public int Allocated;
}

/// <summary><c>struct statvfs</c> (glibc, 64-bit; identical on x64 and arm64).</summary>
[StructLayout(LayoutKind.Sequential)]
public unsafe struct StatVfs
{
    public ulong Bsize, Frsize, Blocks, Bfree, Bavail, Files, Ffree, Favail, Fsid, Flag, Namemax;
    public fixed int Spare[6];
}

/// <summary>The fields of <c>struct stat</c> Synclet uses. atime and ctime are written as mtime.</summary>
public readonly record struct StatData(
    ulong Ino, uint Mode, uint Nlink, uint Uid, uint Gid, long Size, long Blocks, int BlkSize, long MTimeSec, long MTimeNsec);

/// <summary>
/// Reads and writes <c>struct stat</c>, whose layout differs between x86-64 (144 bytes) and the generic
/// layout used by arm64 (128 bytes).
/// </summary>
public static unsafe class StatWriter
{
    private static readonly bool X64 = RuntimeInformation.ProcessArchitecture == Architecture.X64;

    public static int Size => X64 ? 144 : 128;

    private static int Ino => 8;
    private static int Mode => X64 ? 24 : 16;
    private static int Nlink => X64 ? 16 : 20;
    private static int Uid => X64 ? 28 : 24;
    private static int Gid => X64 ? 32 : 28;
    private static int SizeOff => 48;
    private static int BlkSize => 56;
    private static int Blocks => 64;
    private static int ATim => 72;
    private static int MTim => 88;
    private static int CTim => 104;

    public static IReadOnlyDictionary<string, int> Offsets => new Dictionary<string, int>
    {
        ["ino"] = Ino, ["mode"] = Mode, ["nlink"] = Nlink, ["uid"] = Uid, ["gid"] = Gid, ["size"] = SizeOff,
        ["blksize"] = BlkSize, ["blocks"] = Blocks, ["atim"] = ATim, ["mtim"] = MTim, ["ctim"] = CTim,
    };

    public static void Write(byte* dst, in StatData s)
    {
        new Span<byte>(dst, Size).Clear();
        *(ulong*)(dst + Ino) = s.Ino;
        *(uint*)(dst + Mode) = s.Mode;
        if (X64) *(ulong*)(dst + Nlink) = s.Nlink; else *(uint*)(dst + Nlink) = s.Nlink;
        *(uint*)(dst + Uid) = s.Uid;
        *(uint*)(dst + Gid) = s.Gid;
        *(long*)(dst + SizeOff) = s.Size;
        if (X64) *(long*)(dst + BlkSize) = s.BlkSize; else *(int*)(dst + BlkSize) = s.BlkSize;
        *(long*)(dst + Blocks) = s.Blocks;
        foreach (var t in new[] { ATim, MTim, CTim })
        {
            *(long*)(dst + t) = s.MTimeSec;
            *(long*)(dst + t + 8) = s.MTimeNsec;
        }
    }

    public static StatData Read(byte* src) => new(
        Ino: *(ulong*)(src + Ino),
        Mode: *(uint*)(src + Mode),
        Nlink: X64 ? (uint)*(ulong*)(src + Nlink) : *(uint*)(src + Nlink),
        Uid: *(uint*)(src + Uid),
        Gid: *(uint*)(src + Gid),
        Size: *(long*)(src + SizeOff),
        Blocks: *(long*)(src + Blocks),
        BlkSize: X64 ? (int)*(long*)(src + BlkSize) : *(int*)(src + BlkSize),
        MTimeSec: *(long*)(src + MTim),
        MTimeNsec: *(long*)(src + MTim + 8));
}

/// <summary><c>struct fuse_entry_param</c>; its size depends on <see cref="StatWriter.Size"/>.</summary>
public static unsafe class EntryParamWriter
{
    public const int InoOffset = 0;
    public const int GenerationOffset = 8;
    public const int AttrOffset = 16;
    public static int AttrTimeoutOffset => AttrOffset + StatWriter.Size;
    public static int EntryTimeoutOffset => AttrTimeoutOffset + 8;
    public static int Size => EntryTimeoutOffset + 8;

    public static void Write(byte* dst, ulong ino, ulong generation, in StatData attr, double attrTimeout, double entryTimeout)
    {
        new Span<byte>(dst, Size).Clear();
        *(ulong*)(dst + InoOffset) = ino;
        *(ulong*)(dst + GenerationOffset) = generation;
        StatWriter.Write(dst + AttrOffset, attr);
        *(double*)(dst + AttrTimeoutOffset) = attrTimeout;
        *(double*)(dst + EntryTimeoutOffset) = entryTimeout;
    }
}
