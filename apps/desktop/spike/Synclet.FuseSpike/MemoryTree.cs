using System.Text;
using Synclet.Sync.Linux.Fuse;

namespace Synclet.FuseSpike;

/// <summary>
/// In-memory stand-in for the Synclet server: the account root (not writable), "Meine Dateien" and a read-only
/// space "Team Foto". Versions count content uploads the real client would make.
/// </summary>
public sealed class MemoryTree : IFuseFileSystem
{
    public const string SlowFileName = "langsam.bin";
    public const string FailingName = "boom.txt";

    private sealed class Node(ulong ino, Node? parent, string name, bool isDir, bool readOnly)
    {
        public ulong Ino { get; } = ino;
        /// <summary>Identity on the server; survives the save pattern although the inode changes.</summary>
        public ulong ServerId { get; set; } = ino;
        public Node? Parent { get; set; } = parent;
        public string Name { get; set; } = name;
        public bool IsDir { get; } = isDir;
        public bool ReadOnly { get; } = readOnly;
        public Dictionary<string, Node> Children { get; } = new(StringComparer.Ordinal);
        public byte[] Data { get; set; } = [];
        public DateTimeOffset MTime { get; set; } = DateTimeOffset.UtcNow;
        public int Version { get; set; }
    }

    private sealed class Handle(Node node)
    {
        public Node Node { get; } = node;
        public bool Wrote { get; set; }
    }

    private readonly object _lock = new();
    private readonly TimeSpan _readDelay;
    private readonly Dictionary<ulong, Node> _nodes = new();
    private readonly Dictionary<ulong, Handle> _handles = new();
    private readonly Node _root;
    private ulong _nextIno = 2;
    private ulong _nextFh = 1;

    public MemoryTree(TimeSpan readDelay)
    {
        _readDelay = readDelay;
        _root = new Node(1, null, "", isDir: true, readOnly: false);
        _nodes[1] = _root;
        var mine = AddNode(_root, "Meine Dateien", isDir: true, readOnly: false);
        AddFile(mine, "hallo.txt", "Hallo Synclet\n"u8.ToArray(), readOnly: false);
        AddNode(mine, "Dokumente", isDir: true, readOnly: false);
        AddFile(mine, SlowFileName, new byte[1 << 20], readOnly: false);
        var team = AddNode(_root, "Team Foto", isDir: true, readOnly: true);
        AddFile(team, "bild.txt", "Foto\n"u8.ToArray(), readOnly: true);
    }

    /// <summary>Editor and office temp files: kept locally, never uploaded, so they never get a version.</summary>
    public static bool IsTemporary(string name) =>
        name.StartsWith(".goutputstream-", StringComparison.Ordinal)
        || (name.StartsWith(".~lock.", StringComparison.Ordinal) && name.EndsWith('#'))
        || (name.StartsWith("lu", StringComparison.Ordinal) && name.EndsWith(".tmp", StringComparison.Ordinal))
        || name.StartsWith("~$", StringComparison.Ordinal);

    /// <summary>Simulates a change from another device: creates or replaces a file.</summary>
    public (ulong Parent, string Name) AddRemote(string path, string text)
    {
        lock (_lock)
        {
            var (parent, name) = ResolveParent(path);
            if (parent.Children.TryGetValue(name, out var existing))
            {
                existing.Data = Encoding.UTF8.GetBytes(text);
                existing.MTime = DateTimeOffset.UtcNow;
                existing.Version++;
            }
            else
            {
                AddFile(parent, name, Encoding.UTF8.GetBytes(text), parent.ReadOnly);
            }
            return (parent.Ino, name);
        }
    }

    /// <summary>Content version of a file; 0 for temp files, which are never uploaded.</summary>
    public int Version(string path)
    {
        lock (_lock)
        {
            var (parent, name) = ResolveParent(path);
            var node = Child(parent, name);
            return IsTemporary(node.Name) ? 0 : node.Version;
        }
    }

    public ulong ServerId(string path)
    {
        lock (_lock)
        {
            var (parent, name) = ResolveParent(path);
            return Child(parent, name).ServerId;
        }
    }

    public ulong InoOf(string path)
    {
        lock (_lock)
        {
            var (parent, name) = ResolveParent(path);
            return Child(parent, name).Ino;
        }
    }

    public Task<NodeAttr> Lookup(ulong parent, string name) => Run(() =>
    {
        if (Normalize(name) == FailingName) throw new InvalidOperationException("simulated failure");
        return Attr(Child(Dir(parent), Normalize(name)));
    });

    public Task<NodeAttr> GetAttr(ulong ino) => Run(() => Attr(Get(ino)));

    public Task<NodeAttr> SetAttr(ulong ino, long? size, DateTimeOffset? mtime) => Run(() =>
    {
        var node = Get(ino);
        if (size is { } newSize)
        {
            if (node.IsDir) throw new FuseException(Errno.EISDIR);
            if (node.ReadOnly) throw new FuseException(Errno.EROFS);
            var data = node.Data;
            Array.Resize(ref data, checked((int)newSize));
            node.Data = data;
            node.MTime = DateTimeOffset.UtcNow;
            MarkModified(node);
        }
        if (mtime is { } t) node.MTime = t;
        return Attr(node);
    });

    public Task<IReadOnlyList<DirEntry>> ReadDir(ulong ino) => Run<IReadOnlyList<DirEntry>>(() =>
        Dir(ino).Children.Values.OrderBy(n => n.Name, StringComparer.Ordinal)
            .Select(n => new DirEntry(n.Name, Attr(n))).ToList());

    public Task<ulong> Open(ulong ino, bool write, bool truncate) => Run(() =>
    {
        var node = Get(ino);
        if (node.IsDir) throw new FuseException(Errno.EISDIR);
        if ((write || truncate) && node.ReadOnly) throw new FuseException(Errno.EROFS);
        var handle = new Handle(node);
        if (truncate)
        {
            node.Data = [];
            node.MTime = DateTimeOffset.UtcNow;
            handle.Wrote = true;
        }
        var fh = _nextFh++;
        _handles[fh] = handle;
        return fh;
    });

    public async Task<ReadOnlyMemory<byte>> Read(ulong ino, ulong fh, long offset, int size)
    {
        bool slow;
        lock (_lock) slow = HandleOf(fh).Node.Name == SlowFileName;
        if (slow && _readDelay > TimeSpan.Zero) await Task.Delay(_readDelay);
        lock (_lock)
        {
            var data = HandleOf(fh).Node.Data;
            if (offset >= data.Length) return ReadOnlyMemory<byte>.Empty;
            var count = (int)Math.Min(size, data.Length - offset);
            return data.AsSpan((int)offset, count).ToArray();
        }
    }

    public Task<int> Write(ulong ino, ulong fh, long offset, ReadOnlyMemory<byte> data) => Run(() =>
    {
        var handle = HandleOf(fh);
        var node = handle.Node;
        var end = checked((int)(offset + data.Length));
        if (end > node.Data.Length)
        {
            var grown = node.Data;
            Array.Resize(ref grown, end);
            node.Data = grown;
        }
        data.Span.CopyTo(node.Data.AsSpan((int)offset));
        node.MTime = DateTimeOffset.UtcNow;
        handle.Wrote = true;
        return data.Length;
    });

    public Task Release(ulong ino, ulong fh) => Run(() =>
    {
        if (!_handles.Remove(fh, out var handle)) return 0;
        if (handle.Wrote && handle.Node.Parent is not null && !IsTemporary(handle.Node.Name)) handle.Node.Version++;
        return 0;
    });

    public Task<(NodeAttr Attr, ulong Fh)> Create(ulong parent, string name) => Run(() =>
    {
        var dir = WritableDir(parent);
        name = Normalize(name);
        if (dir.Children.ContainsKey(name)) throw new FuseException(Errno.EEXIST);
        var node = AddFile(dir, name, [], readOnly: false);
        node.Version = 0;
        var fh = _nextFh++;
        _handles[fh] = new Handle(node) { Wrote = true };
        return (Attr(node), fh);
    });

    public Task<NodeAttr> MkDir(ulong parent, string name) => Run(() =>
    {
        var dir = WritableDir(parent);
        name = Normalize(name);
        if (dir.Children.ContainsKey(name)) throw new FuseException(Errno.EEXIST);
        return Attr(AddNode(dir, name, isDir: true, readOnly: false));
    });

    public Task Unlink(ulong parent, string name) => Run(() =>
    {
        var dir = WritableDir(parent);
        var node = Child(dir, Normalize(name));
        if (node.IsDir) throw new FuseException(Errno.EISDIR);
        Detach(node);
        return 0;
    });

    public Task RmDir(ulong parent, string name) => Run(() =>
    {
        var dir = WritableDir(parent);
        var node = Child(dir, Normalize(name));
        if (!node.IsDir) throw new FuseException(Errno.ENOTDIR);
        if (node.Children.Count > 0) throw new FuseException(Errno.ENOTEMPTY);
        Detach(node);
        return 0;
    });

    public Task Rename(ulong parent, string name, ulong newParent, string newName) => Run(() =>
    {
        var from = WritableDir(parent);
        var to = WritableDir(newParent);
        name = Normalize(name);
        newName = Normalize(newName);
        var node = Child(from, name);
        if (to.Children.TryGetValue(newName, out var target))
        {
            if (target == node) return 0;
            if (target.IsDir && !node.IsDir) throw new FuseException(Errno.EISDIR);
            if (!target.IsDir && node.IsDir) throw new FuseException(Errno.ENOTDIR);
            if (target.IsDir)
            {
                if (target.Children.Count > 0) throw new FuseException(Errno.EEXIST);
                Detach(target);
            }
            else
            {
                // Save pattern (write temp, rename over the original). The kernel moves the source inode to
                // the target name, so the source node takes over the original's server identity: the server
                // sees one new version of the same item.
                node.ServerId = target.ServerId;
                node.Version = IsTemporary(newName) ? 0 : target.Version + 1;
                node.MTime = DateTimeOffset.UtcNow;
                Detach(target);
            }
        }
        from.Children.Remove(name);
        node.Name = newName;
        node.Parent = to;
        to.Children[newName] = node;
        return 0;
    });

    public Task<FsStats> StatFs() => Task.FromResult(new FsStats(1L << 40, 512L << 30));

    private Task<T> Run<T>(Func<T> body)
    {
        try
        {
            lock (_lock) return Task.FromResult(body());
        }
        catch (Exception e)
        {
            return Task.FromException<T>(e);
        }
    }

    private void MarkModified(Node node)
    {
        var open = _handles.Values.Where(h => h.Node == node).ToList();
        if (open.Count > 0) open.ForEach(h => h.Wrote = true);
        else if (!IsTemporary(node.Name)) node.Version++;
    }

    private static string Normalize(string name) => name.Normalize(NormalizationForm.FormC);

    private static NodeAttr Attr(Node n) =>
        new(n.Ino, n.IsDir, n.IsDir ? 0 : n.Data.Length, n.MTime, n.ReadOnly || n.Ino == 1);

    private Node AddNode(Node parent, string name, bool isDir, bool readOnly)
    {
        var node = new Node(_nextIno++, parent, name, isDir, readOnly);
        parent.Children[name] = node;
        _nodes[node.Ino] = node;
        return node;
    }

    private Node AddFile(Node parent, string name, byte[] data, bool readOnly)
    {
        var node = AddNode(parent, name, isDir: false, readOnly);
        node.Data = data;
        node.Version = 1;
        return node;
    }

    private void Detach(Node node)
    {
        node.Parent?.Children.Remove(node.Name);
        node.Parent = null;
        if (!_handles.Values.Any(h => h.Node == node)) _nodes.Remove(node.Ino);
    }

    private Node Get(ulong ino) => _nodes.TryGetValue(ino, out var n) ? n : throw new FuseException(Errno.ENOENT);

    private Node Dir(ulong ino)
    {
        var node = Get(ino);
        return node.IsDir ? node : throw new FuseException(Errno.ENOTDIR);
    }

    private Node WritableDir(ulong ino)
    {
        var dir = Dir(ino);
        if (dir == _root) throw new FuseException(Errno.EACCES);
        if (dir.ReadOnly) throw new FuseException(Errno.EROFS);
        return dir;
    }

    private static Node Child(Node dir, string name) =>
        dir.Children.TryGetValue(name, out var n) ? n : throw new FuseException(Errno.ENOENT);

    private Handle HandleOf(ulong fh) => _handles.TryGetValue(fh, out var h) ? h : throw new FuseException(Errno.EINVAL);

    private (Node Parent, string Name) ResolveParent(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Normalize).ToArray();
        var dir = _root;
        foreach (var part in parts[..^1]) dir = Child(dir, part);
        return (dir, parts[^1]);
    }
}
