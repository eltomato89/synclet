using System.Diagnostics;
using System.Text;

namespace Synclet.Sync.Linux.Tests;

/// <summary>A running Synclet.FuseSpike process with its own mount point.</summary>
public sealed class SpikeProcess : IAsyncDisposable
{
    public static bool FuseAvailable => File.Exists("/dev/fuse");

    private readonly Process _process;
    private readonly StringBuilder _stderr = new();

    public string MountPoint { get; }
    public int Pid => _process.Id;
    public string Stderr { get { lock (_stderr) return _stderr.ToString(); } }

    private SpikeProcess(string mountPoint, Process process)
    {
        MountPoint = mountPoint;
        _process = process;
    }

    public static async Task<SpikeProcess> Start(int readDelayMs = 0, string? mountPoint = null)
    {
        mountPoint ??= Path.Combine(Directory.CreateTempSubdirectory("synclet-mnt").FullName, "mnt");
        var dll = Path.Combine(AppContext.BaseDirectory, "Synclet.FuseSpike.dll");
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var a in new[] { dll, mountPoint, "--read-delay-ms", readDelayMs.ToString() }) psi.ArgumentList.Add(a);
        var spike = new SpikeProcess(mountPoint, Process.Start(psi)!);
        spike._process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (spike._stderr) spike._stderr.AppendLine(e.Data); };
        spike._process.BeginErrorReadLine();
        var line = await spike.ReadLine(TimeSpan.FromSeconds(10));
        Assert.True(line == "ready", $"spike did not get ready: '{line}', stderr: {spike.Stderr}");
        return spike;
    }

    /// <summary>Sends one stdin command (tab-separated arguments) and returns the response line.</summary>
    public async Task<string?> Send(params string[] parts)
    {
        await _process.StandardInput.WriteLineAsync(string.Join('\t', parts));
        await _process.StandardInput.FlushAsync();
        return await ReadLine(TimeSpan.FromSeconds(10));
    }

    public async Task<string?> ReadLine(TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        try { return await _process.StandardOutput.ReadLineAsync(cts.Token); }
        catch (OperationCanceledException) { return null; }
    }

    public async Task<int> WaitForExit(TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        await _process.WaitForExitAsync(cts.Token);
        return _process.ExitCode;
    }

    public static bool IsMounted(string mountPoint) =>
        File.ReadAllLines("/proc/mounts").Any(l => l.Split(' ')[1] == mountPoint.Replace(" ", "\\040"));

    /// <summary>Runs a bash command with the mount point as working directory.</summary>
    public (int Exit, string Out, string Err) Sh(string command) => Shell.Run(command, MountPoint);

    public async ValueTask DisposeAsync()
    {
        if (!_process.HasExited)
        {
            try
            {
                await _process.StandardInput.WriteLineAsync("quit");
                await _process.StandardInput.FlushAsync();
                await WaitForExit(TimeSpan.FromSeconds(10));
            }
            catch (Exception)
            {
                _process.Kill();
            }
        }
        Shell.Run($"fusermount3 -uz '{MountPoint}' 2>/dev/null; true", "/");
        _process.Dispose();
    }
}

public static class Shell
{
    public static (int Exit, string Out, string Err) Run(string command, string workingDirectory)
    {
        var psi = new ProcessStartInfo("bash") { RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = workingDirectory };
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(command);
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        p.WaitForExit();
        return (p.ExitCode, stdout.Result.TrimEnd('\n'), stderr.Result.TrimEnd('\n'));
    }
}

/// <summary>One shared spike for a test class; tests use distinct file names.</summary>
public sealed class MountFixture : IAsyncLifetime
{
    public SpikeProcess? Spike { get; private set; }

    public async ValueTask InitializeAsync()
    {
        if (SpikeProcess.FuseAvailable) Spike = await SpikeProcess.Start();
    }

    public async ValueTask DisposeAsync()
    {
        if (Spike is not null)
        {
            var mount = Spike.MountPoint;
            await Spike.DisposeAsync();
            Assert.False(SpikeProcess.IsMounted(mount), "mount point still mounted after quit");
        }
    }
}
