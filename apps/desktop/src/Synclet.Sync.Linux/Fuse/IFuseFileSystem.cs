namespace Synclet.Sync.Linux.Fuse;

/// <summary>Attributes of one node. Inode 1 is the mount root.</summary>
public sealed record NodeAttr(ulong Ino, bool IsDir, long Size, DateTimeOffset MTime, bool ReadOnly);

public sealed record DirEntry(string Name, NodeAttr Attr);

public sealed record FsStats(long TotalBytes, long FreeBytes);

/// <summary>
/// A file system served over FUSE. Every member may complete asynchronously; errors are reported as
/// <see cref="FuseException"/>. Any other exception is answered with EIO. Names arrive NFC-normalized.
/// </summary>
public interface IFuseFileSystem
{
    Task<NodeAttr> Lookup(ulong parent, string name);
    Task<NodeAttr> GetAttr(ulong ino);
    Task<NodeAttr> SetAttr(ulong ino, long? size, DateTimeOffset? mtime);
    Task<IReadOnlyList<DirEntry>> ReadDir(ulong ino);
    Task<ulong> Open(ulong ino, bool write, bool truncate);
    Task<ReadOnlyMemory<byte>> Read(ulong ino, ulong fh, long offset, int size);
    Task<int> Write(ulong ino, ulong fh, long offset, ReadOnlyMemory<byte> data);
    Task Release(ulong ino, ulong fh);
    Task<(NodeAttr Attr, ulong Fh)> Create(ulong parent, string name);
    Task<NodeAttr> MkDir(ulong parent, string name);
    Task Unlink(ulong parent, string name);
    Task RmDir(ulong parent, string name);
    Task Rename(ulong parent, string name, ulong newParent, string newName);
    Task<FsStats> StatFs();
}
