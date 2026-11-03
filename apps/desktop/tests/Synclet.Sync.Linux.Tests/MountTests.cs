namespace Synclet.Sync.Linux.Tests;

public sealed class MountTests(MountFixture fixture) : IClassFixture<MountFixture>
{
    private SpikeProcess Spike
    {
        get
        {
            Assert.SkipUnless(SpikeProcess.FuseAvailable, "/dev/fuse not available");
            return fixture.Spike!;
        }
    }

    private (int Exit, string Out, string Err) Ok(string command)
    {
        var r = Spike.Sh(command);
        Assert.True(r.Exit == 0, $"'{command}' failed ({r.Exit}): {r.Err}\nspike stderr: {Spike.Stderr}");
        return r;
    }

    [Fact]
    public void Ls_shows_spaces() =>
        Assert.Equal(["Meine Dateien", "Team Foto"], Ok("ls -1").Out.Split('\n'));

    [Fact]
    public void Cat_reads_file() =>
        Assert.Equal("Hallo Synclet", Ok("cat 'Meine Dateien/hallo.txt'").Out);

    [Fact]
    public void Write_new_file_and_read_back() =>
        Assert.Equal("abc", Ok("printf abc > 'Meine Dateien/neu.txt' && cat 'Meine Dateien/neu.txt'").Out);

    [Fact]
    public async Task Overwrite_bumps_version()
    {
        Ok("printf eins > 'Meine Dateien/v.txt'");
        Assert.Equal("version 1", await Spike.Send("version", "/Meine Dateien/v.txt"));
        Ok("echo x > 'Meine Dateien/v.txt'");
        Assert.Equal("version 2", await Spike.Send("version", "/Meine Dateien/v.txt"));
    }

    [Fact]
    public void Big_copy_roundtrip()
    {
        Ok("dd if=/dev/urandom of=/tmp/synclet-big bs=1M count=64 status=none && cp /tmp/synclet-big 'Meine Dateien/big.bin'");
        var sums = Ok("sha256sum /tmp/synclet-big 'Meine Dateien/big.bin' | cut -d' ' -f1").Out.Split('\n');
        Assert.Equal(sums[0], sums[1]);
        Assert.Equal((64 << 20).ToString(), Ok("stat -c %s 'Meine Dateien/big.bin'").Out);
    }

    [Fact]
    public void Mv_and_rm_work()
    {
        Ok("printf m > 'Meine Dateien/mv-a.txt' && mv 'Meine Dateien/mv-a.txt' 'Meine Dateien/Dokumente/mv-b.txt'");
        Assert.Equal("m", Ok("cat 'Meine Dateien/Dokumente/mv-b.txt'").Out);
        Assert.NotEqual(0, Spike.Sh("test -e 'Meine Dateien/mv-a.txt'").Exit);
        Ok("rm 'Meine Dateien/Dokumente/mv-b.txt'");
        Assert.NotEqual(0, Spike.Sh("test -e 'Meine Dateien/Dokumente/mv-b.txt'").Exit);
    }

    [Fact]
    public void Mkdir_and_rmdir_work()
    {
        Ok("mkdir 'Meine Dateien/Ordner' && test -d 'Meine Dateien/Ordner'");
        Ok("rmdir 'Meine Dateien/Ordner'");
        Assert.NotEqual(0, Spike.Sh("test -e 'Meine Dateien/Ordner'").Exit);
    }

    [Fact]
    public void Read_only_space_rejects_writes()
    {
        var r = Spike.Sh("touch 'Team Foto/x'");
        Assert.NotEqual(0, r.Exit);
        Assert.Contains("Read-only file system", r.Err);
        Assert.Contains("Read-only file system", Spike.Sh("echo x >> 'Team Foto/bild.txt'").Err);
    }

    [Fact]
    public void Root_rejects_writes()
    {
        var r = Spike.Sh("mkdir neu");
        Assert.NotEqual(0, r.Exit);
        Assert.Contains("Permission denied", r.Err);
    }

    [Fact]
    public void Df_reports_free_space() =>
        Assert.True(long.Parse(Ok("df -B1 --output=avail . | tail -1").Out.Trim()) > 0);

    [Fact]
    public void Umlaut_file_roundtrip()
    {
        Ok("echo hi > 'Meine Dateien/Grüße.txt'");
        Assert.Contains("Grüße.txt", Ok("ls 'Meine Dateien'").Out.Split('\n'));
        Assert.Equal("hi", Ok("cat 'Meine Dateien/Grüße.txt'").Out);
    }

    [Fact]
    public async Task Gio_save_order_counts_one_version()
    {
        Ok("printf alt > 'Meine Dateien/gio.txt'");
        var serverId = await Spike.Send("id", "/Meine Dateien/gio.txt");
        // Same order as g_file_replace (GNOME Text Editor): rename over the original while the temp is still open.
        Ok("cd 'Meine Dateien' && exec 3> .goutputstream-OCQ4X3 && printf neu >&3 && mv -f .goutputstream-OCQ4X3 gio.txt && exec 3>&-");
        Assert.Equal("neu", Ok("cat 'Meine Dateien/gio.txt'").Out);
        Assert.Equal(serverId, await Spike.Send("id", "/Meine Dateien/gio.txt"));
        Assert.Equal("version 2", await Spike.Send("version", "/Meine Dateien/gio.txt"));
    }

    [Fact]
    public async Task Gedit_pattern_via_shell()
    {
        Ok("printf alt > 'Meine Dateien/g.txt'");
        var serverId = await Spike.Send("id", "/Meine Dateien/g.txt");
        Assert.StartsWith("id ", serverId);
        Ok("cd 'Meine Dateien' && printf neu > .goutputstream-XY12 && mv -f .goutputstream-XY12 g.txt");
        Assert.Equal(serverId, await Spike.Send("id", "/Meine Dateien/g.txt"));
        Assert.Equal(Ok("stat -c %i 'Meine Dateien/g.txt'").Out, Ok("ls -i 'Meine Dateien/g.txt' | cut -d' ' -f1").Out);
        Assert.Equal("neu", Ok("cat 'Meine Dateien/g.txt'").Out);
        Assert.Equal("version 2", await Spike.Send("version", "/Meine Dateien/g.txt"));
        Assert.NotEqual(0, Spike.Sh("test -e 'Meine Dateien/.goutputstream-XY12'").Exit);
    }
}
