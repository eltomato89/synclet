// Synclet FUSE spike: mounts an in-memory tree and takes control commands on stdin.
//   Synclet.FuseSpike <mountpoint> [--read-delay-ms 2000]
// stdin (tab-separated): add-remote <path> <text> → ok | version <path> → version <n> | id <path> → id <n> | quit
// End of stdin does not stop the spike; SIGTERM/SIGINT or an external unmount do.
using System.Runtime.InteropServices;
using Synclet.FuseSpike;
using Synclet.Sync.Linux.Fuse;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: Synclet.FuseSpike <mountpoint> [--read-delay-ms 2000]");
    return 2;
}

var mountPoint = args[0];
var delayIndex = Array.IndexOf(args, "--read-delay-ms");
var readDelay = TimeSpan.FromMilliseconds(delayIndex >= 0 ? int.Parse(args[delayIndex + 1]) : 2000);

var tree = new MemoryTree(readDelay);
using var session = FuseSession.Mount(mountPoint, tree, new FuseOptions(TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60)));
session.Start();

using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Stop);
using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, Stop);

var commands = new Thread(() =>
{
    while (Console.In.ReadLine() is { } line)
    {
        var parts = line.Split('\t');
        try
        {
            switch (parts[0])
            {
                case "quit":
                    session.Stop();
                    return;
                case "version":
                    Console.WriteLine($"version {tree.Version(parts[1])}");
                    break;
                case "id":
                    Console.WriteLine($"id {tree.ServerId(parts[1])}");
                    break;
                case "add-remote":
                    var (parent, name) = tree.AddRemote(parts[1], parts[2]);
                    session.InvalidateEntry(parent, name);
                    session.InvalidateInode(parent);
                    session.InvalidateInode(tree.InoOf(parts[1]));
                    Console.WriteLine("ok");
                    break;
                default:
                    Console.WriteLine($"error unknown command {parts[0]}");
                    break;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine($"error {e.Message}");
        }
    }
}) { IsBackground = true, Name = "commands" };
commands.Start();

Console.WriteLine("ready");
session.WaitForExit(Timeout.InfiniteTimeSpan);
Console.Error.WriteLine("synclet-fuse: unmounted");
return 0;

void Stop(PosixSignalContext context)
{
    context.Cancel = true;
    session.Stop();
}
