namespace Synclet.Sync.Linux.Tests;

/// <summary>Each test starts its own spike, because several of them kill or unmount it.</summary>
public sealed class MountRobustnessTests
{
    private static async Task<SpikeProcess> Start(int readDelayMs = 0, string? mountPoint = null)
    {
        Assert.SkipUnless(SpikeProcess.FuseAvailable, "/dev/fuse not available");
        return await SpikeProcess.Start(readDelayMs, mountPoint);
    }

    private static string Ok(SpikeProcess spike, string command)
    {
        var r = spike.Sh(command);
        Assert.True(r.Exit == 0, $"'{command}' failed ({r.Exit}): {r.Err}\nspike stderr: {spike.Stderr}");
        return r.Out;
    }

    [Fact]
    public async Task Slow_read_does_not_block_listing()
    {
        await using var spike = await Start(readDelayMs: 3000);
        var ms = Ok(spike, """
            cd 'Meine Dateien'
            cat langsam.bin > /dev/null &
            sleep 0.2
            s=$(date +%s%N); ls > /dev/null; stat hallo.txt > /dev/null; e=$(date +%s%N)
            kill %1 2>/dev/null
            echo $(( (e - s) / 1000000 ))
            """);
        Assert.True(int.Parse(ms) < 500, $"listing took {ms} ms while a slow read was pending");
    }

    [Fact]
    public async Task Remote_add_is_visible_despite_60s_cache()
    {
        await using var spike = await Start();
        Assert.DoesNotContain("remote.txt", Ok(spike, "ls 'Meine Dateien'"));
        Assert.NotEqual(0, spike.Sh("stat 'Meine Dateien/remote.txt'").Exit);
        Assert.Equal("ok", await spike.Send("add-remote", "/Meine Dateien/remote.txt", "hallo"));
        Assert.Equal("hallo", Ok(spike, "cat 'Meine Dateien/remote.txt'"));
        Assert.Contains("remote.txt", Ok(spike, "ls 'Meine Dateien'"));
    }

    [Fact]
    public async Task Remote_change_of_open_file_content_is_visible()
    {
        await using var spike = await Start();
        Assert.Equal("Hallo Synclet", Ok(spike, "cat 'Meine Dateien/hallo.txt'"));
        Assert.Equal("14", Ok(spike, "stat -c %s 'Meine Dateien/hallo.txt'"));
        Assert.Equal("ok", await spike.Send("add-remote", "/Meine Dateien/hallo.txt", "neu"));
        Assert.Equal("3", Ok(spike, "stat -c %s 'Meine Dateien/hallo.txt'"));
        Assert.Equal("neu", Ok(spike, "cat 'Meine Dateien/hallo.txt'"));
    }

    [Fact]
    public async Task Callback_exception_returns_EIO_and_mount_survives()
    {
        await using var spike = await Start();
        var r = spike.Sh("cat 'Meine Dateien/boom.txt'");
        Assert.NotEqual(0, r.Exit);
        Assert.Contains("Input/output error", r.Err);
        Assert.Contains("simulated failure", spike.Stderr);
        Assert.Equal("Hallo Synclet", Ok(spike, "cat 'Meine Dateien/hallo.txt'"));
    }

    [Fact]
    public async Task Sigterm_unmounts_cleanly()
    {
        await using var spike = await Start();
        Ok(spike, $"kill -TERM {spike.Pid}");
        Assert.Equal(0, await spike.WaitForExit(TimeSpan.FromSeconds(10)));
        Assert.False(SpikeProcess.IsMounted(spike.MountPoint));
    }

    [Fact]
    public async Task Kill9_leaves_stale_mount_that_next_start_cleans()
    {
        var first = await Start();
        var mount = first.MountPoint;
        Shell.Run($"kill -9 {first.Pid}", "/");
        await first.WaitForExit(TimeSpan.FromSeconds(10));
        Assert.Contains("Transport endpoint is not connected", Shell.Run($"ls '{mount}'", "/").Err);

        await using var second = await Start(mountPoint: mount);
        Assert.Contains("Meine Dateien", Ok(second, "ls"));
        await first.DisposeAsync();
    }

    [Fact]
    public async Task External_fusermount_u_ends_process()
    {
        await using var spike = await Start();
        var r = Shell.Run($"fusermount3 -u '{spike.MountPoint}'", "/");
        Assert.True(r.Exit == 0, r.Err);
        Assert.Equal(0, await spike.WaitForExit(TimeSpan.FromSeconds(5)));
        Assert.False(SpikeProcess.IsMounted(spike.MountPoint));
    }
}
