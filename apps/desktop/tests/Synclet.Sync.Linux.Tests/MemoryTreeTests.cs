using System.Text;
using Synclet.FuseSpike;
using Synclet.Sync.Linux.Fuse;

namespace Synclet.Sync.Linux.Tests;

public sealed class MemoryTreeTests
{
    private readonly MemoryTree _tree = new(TimeSpan.Zero);

    private async Task<NodeAttr> Path(string path)
    {
        var attr = await _tree.GetAttr(1);
        foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
            attr = await _tree.Lookup(attr.Ino, part);
        return attr;
    }

    private async Task<string> ReadAll(ulong ino)
    {
        var fh = await _tree.Open(ino, write: false, truncate: false);
        var data = await _tree.Read(ino, fh, 0, 1 << 20);
        await _tree.Release(ino, fh);
        return Encoding.UTF8.GetString(data.Span);
    }

    private async Task<ulong> CreateWithText(ulong parent, string name, string text)
    {
        var (attr, fh) = await _tree.Create(parent, name);
        await _tree.Write(attr.Ino, fh, 0, Encoding.UTF8.GetBytes(text));
        await _tree.Release(attr.Ino, fh);
        return attr.Ino;
    }

    private static async Task<int> Errno(Func<Task> action) =>
        (await Assert.ThrowsAsync<FuseException>(action)).Errno;

    [Fact]
    public async Task Lookup_finds_start_tree()
    {
        Assert.True((await _tree.Lookup(1, "Meine Dateien")).IsDir);
        Assert.Equal(14, (await Path("/Meine Dateien/hallo.txt")).Size);
        Assert.True((await Path("/Team Foto")).ReadOnly);
        Assert.Equal("Foto\n", await ReadAll((await Path("/Team Foto/bild.txt")).Ino));
        Assert.Equal(1 << 20, (await Path("/Meine Dateien/langsam.bin")).Size);
        Assert.True((await Path("/Meine Dateien/Dokumente")).IsDir);
    }

    [Fact]
    public async Task Lookup_unknown_throws_ENOENT() =>
        Assert.Equal(Fuse.Errno.ENOENT, await Errno(() => _tree.Lookup(1, "gibt-es-nicht")));

    [Fact]
    public async Task Create_in_root_throws_EACCES()
    {
        Assert.Equal(Fuse.Errno.EACCES, await Errno(() => _tree.Create(1, "x.txt")));
        Assert.Equal(Fuse.Errno.EACCES, await Errno(() => _tree.MkDir(1, "neu")));
    }

    [Fact]
    public async Task Create_in_read_only_space_throws_EROFS()
    {
        var team = await Path("/Team Foto");
        Assert.Equal(Fuse.Errno.EROFS, await Errno(() => _tree.Create(team.Ino, "x.txt")));
        var bild = await Path("/Team Foto/bild.txt");
        Assert.Equal(Fuse.Errno.EROFS, await Errno(() => _tree.Open(bild.Ino, write: true, truncate: false)));
    }

    [Fact]
    public async Task Unlink_in_read_only_space_throws_EROFS()
    {
        var team = await Path("/Team Foto");
        Assert.Equal(Fuse.Errno.EROFS, await Errno(() => _tree.Unlink(team.Ino, "bild.txt")));
    }

    [Fact]
    public async Task Write_then_release_bumps_version()
    {
        var hallo = await Path("/Meine Dateien/hallo.txt");
        var fh = await _tree.Open(hallo.Ino, write: true, truncate: false);
        await _tree.Release(hallo.Ino, fh);
        Assert.Equal(1, _tree.Version("/Meine Dateien/hallo.txt"));

        fh = await _tree.Open(hallo.Ino, write: true, truncate: true);
        Assert.Equal(3, await _tree.Write(hallo.Ino, fh, 0, "neu"u8.ToArray()));
        await _tree.Release(hallo.Ino, fh);
        Assert.Equal(2, _tree.Version("/Meine Dateien/hallo.txt"));
        Assert.Equal("neu", await ReadAll(hallo.Ino));
    }

    [Fact]
    public async Task Gedit_save_pattern_keeps_server_id_and_bumps_version_once()
    {
        var dir = await Path("/Meine Dateien");
        var serverId = _tree.ServerId("/Meine Dateien/hallo.txt");
        var tempIno = await CreateWithText(dir.Ino, ".goutputstream-AB12", "neuer Inhalt");
        await _tree.Rename(dir.Ino, ".goutputstream-AB12", dir.Ino, "hallo.txt");

        // The kernel moves the source inode to the target name, so the inode is the temp file's one.
        var after = await Path("/Meine Dateien/hallo.txt");
        Assert.Equal(tempIno, after.Ino);
        Assert.Equal(serverId, _tree.ServerId("/Meine Dateien/hallo.txt"));
        Assert.Equal("neuer Inhalt", await ReadAll(after.Ino));
        Assert.Equal(2, _tree.Version("/Meine Dateien/hallo.txt"));
        Assert.Equal(Fuse.Errno.ENOENT, await Errno(() => _tree.Lookup(dir.Ino, ".goutputstream-AB12")));
    }

    [Fact]
    public async Task Temporary_files_never_get_versions()
    {
        var dir = await Path("/Meine Dateien");
        await CreateWithText(dir.Ino, ".~lock.hallo.txt#", "lock");
        Assert.Equal(0, _tree.Version("/Meine Dateien/.~lock.hallo.txt#"));
        Assert.True(MemoryTree.IsTemporary(".goutputstream-XY12"));
        Assert.True(MemoryTree.IsTemporary("lu12345.tmp"));
        Assert.True(MemoryTree.IsTemporary("~$Bericht.docx"));
        Assert.False(MemoryTree.IsTemporary("hallo.txt"));
    }

    [Fact]
    public async Task Umlaut_names_roundtrip()
    {
        var dir = await Path("/Meine Dateien");
        var nfc = "Grüße.txt".Normalize(NormalizationForm.FormC);
        var ino = await CreateWithText(dir.Ino, nfc, "hi");
        Assert.Contains(await _tree.ReadDir(dir.Ino), e => e.Name == nfc);
        Assert.Equal(ino, (await _tree.Lookup(dir.Ino, nfc.Normalize(NormalizationForm.FormD))).Ino);
    }

    [Fact]
    public async Task RmDir_non_empty_throws_ENOTEMPTY()
    {
        var dir = await Path("/Meine Dateien");
        var docs = await Path("/Meine Dateien/Dokumente");
        await CreateWithText(docs.Ino, "a.txt", "a");
        Assert.Equal(Fuse.Errno.ENOTEMPTY, await Errno(() => _tree.RmDir(dir.Ino, "Dokumente")));
    }

    [Fact]
    public async Task Rename_onto_existing_dir_throws_EEXIST()
    {
        var dir = await Path("/Meine Dateien");
        await _tree.MkDir(dir.Ino, "Andere");
        await CreateWithText((await Path("/Meine Dateien/Andere")).Ino, "b.txt", "b");
        Assert.Equal(Fuse.Errno.EEXIST, await Errno(() => _tree.Rename(dir.Ino, "Dokumente", dir.Ino, "Andere")));
    }

    [Fact]
    public async Task SetAttr_size_truncates()
    {
        var hallo = await Path("/Meine Dateien/hallo.txt");
        Assert.Equal(5, (await _tree.SetAttr(hallo.Ino, 5, null)).Size);
        Assert.Equal("Hallo", await ReadAll(hallo.Ino));
    }

    [Fact]
    public async Task AddRemote_creates_file_and_returns_parent()
    {
        var dir = await Path("/Meine Dateien");
        var (parent, name) = _tree.AddRemote("/Meine Dateien/remote.txt", "vom Server");
        Assert.Equal(dir.Ino, parent);
        Assert.Equal("remote.txt", name);
        Assert.Equal("vom Server", await ReadAll((await Path("/Meine Dateien/remote.txt")).Ino));
    }

    [Fact]
    public async Task StatFs_reports_free_space()
    {
        var stats = await _tree.StatFs();
        Assert.Equal(1L << 40, stats.TotalBytes);
        Assert.Equal(512L << 30, stats.FreeBytes);
    }
}
