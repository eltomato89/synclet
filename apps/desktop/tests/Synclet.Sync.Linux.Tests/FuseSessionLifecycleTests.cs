using System.Diagnostics;
using Synclet.FuseSpike;
using Synclet.Sync.Linux.Fuse;

namespace Synclet.Sync.Linux.Tests;

/// <summary>Mounts inside the test process to check FuseSession's shutdown contract.</summary>
public sealed class FuseSessionLifecycleTests
{
    private static readonly FuseOptions Options = new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

    private static string NewMountPoint()
    {
        Assert.SkipUnless(SpikeProcess.FuseAvailable, "/dev/fuse not available");
        return Path.Combine(Directory.CreateTempSubdirectory("synclet-life").FullName, "mnt");
    }

    private static async Task WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var sw = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(sw.Elapsed < timeout, "condition not reached in time");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task Dispose_waits_for_in_flight_replies_before_destroying_the_session()
    {
        var mount = NewMountPoint();
        var session = FuseSession.Mount(mount, new MemoryTree(TimeSpan.FromMilliseconds(1500)), Options);
        session.Start();
        using var cat = Process.Start("bash", ["-c", $"cat '{mount}/Meine Dateien/langsam.bin' > /dev/null"]);
        await WaitUntil(() => session.InFlight > 0, TimeSpan.FromSeconds(5));

        session.Dispose();

        Assert.Equal(0, session.InFlight);
        Assert.False(SpikeProcess.IsMounted(mount));
        Assert.True(cat.WaitForExit(10_000), "reader still blocked after dispose");
    }

    /// <summary>Reads wait until the test opens the gate.</summary>
    private sealed class GatedTree(Task gate) : IFuseFileSystem
    {
        private readonly MemoryTree _tree = new(TimeSpan.Zero);
        public Task<NodeAttr> Lookup(ulong parent, string name) => _tree.Lookup(parent, name);
        public Task<NodeAttr> GetAttr(ulong ino) => _tree.GetAttr(ino);
        public Task<NodeAttr> SetAttr(ulong ino, long? size, DateTimeOffset? mtime) => _tree.SetAttr(ino, size, mtime);
        public Task<IReadOnlyList<DirEntry>> ReadDir(ulong ino) => _tree.ReadDir(ino);
        public Task<ulong> Open(ulong ino, bool write, bool truncate) => _tree.Open(ino, write, truncate);
        public async Task<ReadOnlyMemory<byte>> Read(ulong ino, ulong fh, long offset, int size)
        {
            await gate;
            return await _tree.Read(ino, fh, offset, size);
        }
        public Task<int> Write(ulong ino, ulong fh, long offset, ReadOnlyMemory<byte> data) => _tree.Write(ino, fh, offset, data);
        public Task Release(ulong ino, ulong fh) => _tree.Release(ino, fh);
        public Task<(NodeAttr Attr, ulong Fh)> Create(ulong parent, string name) => _tree.Create(parent, name);
        public Task<NodeAttr> MkDir(ulong parent, string name) => _tree.MkDir(parent, name);
        public Task Unlink(ulong parent, string name) => _tree.Unlink(parent, name);
        public Task RmDir(ulong parent, string name) => _tree.RmDir(parent, name);
        public Task Rename(ulong parent, string name, ulong newParent, string newName) => _tree.Rename(parent, name, newParent, newName);
        public Task<FsStats> StatFs() => _tree.StatFs();
    }

    [Fact]
    public async Task Dispose_after_connection_abort_waits_for_the_pending_reply()
    {
        var mount = NewMountPoint();
        var gate = new TaskCompletionSource();
        var session = FuseSession.Mount(mount, new GatedTree(gate.Task), Options);
        session.Start();
        var dev = Shell.Run($"stat -c %d '{mount}'", "/").Out;
        using var cat = Process.Start("bash", ["-c", $"cat '{mount}/Meine Dateien/hallo.txt' > /dev/null"]);
        await WaitUntil(() => session.InFlight > 0, TimeSpan.FromSeconds(5));

        // Aborting the connection makes fuse_session_loop return while the read is still unanswered.
        var abort = Shell.Run("mountpoint -q /sys/fs/fuse/connections || mount -t fusectl none /sys/fs/fuse/connections; " +
                              $"echo 1 > /sys/fs/fuse/connections/{dev}/abort", "/");
        Assert.True(abort.Exit == 0, abort.Err);
        var dispose = Task.Run(session.Dispose, TestContext.Current.CancellationToken);
        await Task.Delay(500, TestContext.Current.CancellationToken);
        Assert.False(dispose.IsCompleted, "Dispose returned while a reply was still pending");

        gate.SetResult();
        await dispose.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.Equal(0, session.InFlight);
        Assert.True(cat.WaitForExit(10_000));
    }

    [Fact]
    public void Notifications_after_dispose_throw_ObjectDisposedException()
    {
        var session = FuseSession.Mount(NewMountPoint(), new MemoryTree(TimeSpan.Zero), Options);
        session.Start();
        session.Dispose();
        Assert.Throws<ObjectDisposedException>(() => session.InvalidateEntry(1, "x"));
        Assert.Throws<ObjectDisposedException>(() => session.InvalidateInode(1));
        session.Dispose();
    }

    [Fact]
    public void Dispose_without_start_unmounts()
    {
        var mount = NewMountPoint();
        var session = FuseSession.Mount(mount, new MemoryTree(TimeSpan.Zero), Options);
        Assert.True(SpikeProcess.IsMounted(mount));
        session.Dispose();
        Assert.False(SpikeProcess.IsMounted(mount));
    }

    [Fact]
    public async Task External_unmount_ends_the_loop_and_WaitForExit_returns()
    {
        var mount = NewMountPoint();
        using var session = FuseSession.Mount(mount, new MemoryTree(TimeSpan.Zero), Options);
        session.Start();
        Assert.Equal(0, Shell.Run($"fusermount3 -u '{mount}'", "/").Exit);
        Assert.True(await Task.Run(() => session.WaitForExit(TimeSpan.FromSeconds(5))));
    }
}
