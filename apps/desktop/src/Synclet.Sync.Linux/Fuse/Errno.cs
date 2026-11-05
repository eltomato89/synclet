namespace Synclet.Sync.Linux.Fuse;

/// <summary>Linux errno values used by the FUSE layer.</summary>
public static class Errno
{
    public const int ENOENT = 2;
    public const int EIO = 5;
    public const int EACCES = 13;
    public const int EEXIST = 17;
    public const int ENOTDIR = 20;
    public const int EISDIR = 21;
    public const int EINVAL = 22;
    public const int EROFS = 30;
    public const int ENOSYS = 38;
    public const int ENOTEMPTY = 39;
}

/// <summary>Thrown by an <see cref="IFuseFileSystem"/> to answer a request with an errno.</summary>
public sealed class FuseException(int errno) : Exception($"errno {errno}")
{
    public int Errno { get; } = errno;
}
