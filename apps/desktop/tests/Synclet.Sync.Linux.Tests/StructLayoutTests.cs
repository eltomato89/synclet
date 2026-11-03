using System.Diagnostics;
using System.Runtime.InteropServices;
using Synclet.Sync.Linux.Fuse.Native;

namespace Synclet.Sync.Linux.Tests;

public sealed unsafe class StructLayoutTests
{
    [Fact]
    public void Layouts_match_libfuse_headers()
    {
        var c = NativeLayout();
        var mismatches = new List<string>();
        void Check(string key, long actual)
        {
            if (!c.TryGetValue(key, out var expected)) mismatches.Add($"{key}: missing in offsets.c output");
            else if (expected != actual) mismatches.Add($"{key}: C {expected}, C# {actual}");
        }

        Check("sizeof_stat", StatWriter.Size);
        foreach (var (name, offset) in StatWriter.Offsets) Check($"stat.{name}", offset);

        Check("sizeof_entry_param", EntryParamWriter.Size);
        Check("entry.ino", EntryParamWriter.InoOffset);
        Check("entry.generation", EntryParamWriter.GenerationOffset);
        Check("entry.attr", EntryParamWriter.AttrOffset);
        Check("entry.attr_timeout", EntryParamWriter.AttrTimeoutOffset);
        Check("entry.entry_timeout", EntryParamWriter.EntryTimeoutOffset);

        Check("sizeof_file_info", sizeof(FuseFileInfo));
        Check("fi.flags", Marshal.OffsetOf<FuseFileInfo>(nameof(FuseFileInfo.Flags)));
        Check("fi.fh", Marshal.OffsetOf<FuseFileInfo>(nameof(FuseFileInfo.Fh)));

        Check("sizeof_ops", sizeof(FuseLowlevelOps));
        foreach (var op in new[] { "init", "lookup", "getattr", "setattr", "mkdir", "unlink", "rmdir", "rename", "open",
                     "read", "write", "release", "readdir", "statfs", "create", "ioctl", "readdirplus", "lseek" })
        {
            var field = typeof(FuseLowlevelOps).GetFields()
                .Single(f => string.Equals(f.Name, op.Replace("_", ""), StringComparison.OrdinalIgnoreCase)).Name;
            Check($"ops.{op}", Marshal.OffsetOf<FuseLowlevelOps>(field));
        }

        Check("sizeof_args", sizeof(FuseArgs));
        Check("sizeof_statvfs", sizeof(StatVfs));
        Check("statvfs.bavail", Marshal.OffsetOf<StatVfs>(nameof(StatVfs.Bavail)));
        Check("statvfs.namemax", Marshal.OffsetOf<StatVfs>(nameof(StatVfs.Namemax)));

        Assert.Empty(mismatches);
    }

    [Fact]
    public void StatWriter_roundtrip()
    {
        var data = new StatData(Ino: 42, Mode: 0x81A4, Nlink: 1, Uid: 1000, Gid: 1001, Size: 123_456_789_012,
            Blocks: 241_127_323, BlkSize: 4096, MTimeSec: 1_762_160_000, MTimeNsec: 123_000_000);
        var buffer = stackalloc byte[StatWriter.Size];
        StatWriter.Write(buffer, data);
        Assert.Equal(data, StatWriter.Read(buffer));
    }

    private static Dictionary<string, long> NativeLayout()
    {
        var dir = Directory.CreateTempSubdirectory("synclet-offsets").FullName;
        var exe = Path.Combine(dir, "offsets");
        var src = Path.Combine(AppContext.BaseDirectory, "native", "offsets.c");
        Run("bash", $"-c \"gcc $(pkg-config --cflags fuse3) -o '{exe}' '{src}'\"");
        return Run(exe, "")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split('='))
            .ToDictionary(p => p[0], p => long.Parse(p[1]));
    }

    private static string Run(string file, string args)
    {
        using var p = Process.Start(new ProcessStartInfo(file, args)
            { RedirectStandardOutput = true, RedirectStandardError = true })!;
        var output = p.StandardOutput.ReadToEnd();
        var error = p.StandardError.ReadToEnd();
        p.WaitForExit();
        Assert.True(p.ExitCode == 0, $"{file} {args} failed: {error}");
        return output;
    }
}
