import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { heifToJpeg, runTool, ToolFailedError, ToolMissingError, ToolTimeoutError } from './tools';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('external tools', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-tools-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('kills a tool that exceeds its timeout', async () => {
    const fake = path.join(dir, 'fake-heif-convert');
    const pidFile = path.join(dir, 'pid');
    // `exec` replaces the shell, so the recorded pid is the sleeping process itself.
    await writeFile(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    await chmod(fake, 0o755);
    const started = Date.now();
    await expect(heifToJpeg(path.join(dir, 'in.heic'), path.join(dir, 'out'), { bin: { 'heif-convert': fake }, timeoutMs: 300 }))
      .rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it('reports a missing binary and a failing tool distinctly', async () => {
    await expect(runTool('synclet-no-such-tool', [])).rejects.toBeInstanceOf(ToolMissingError);
    await expect(runTool('sh', ['-c', 'echo broken >&2; exit 3'])).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('fails when the tool exits 0 but writes no output', async () => {
    await expect(heifToJpeg(path.join(dir, 'in.heic'), path.join(dir, 'out'), { bin: { 'heif-convert': 'true' } }))
      .rejects.toBeInstanceOf(ToolFailedError);
  });

  it('rejects relative inputs', async () => {
    await expect(heifToJpeg('-rf.heic', path.join(dir, 'out'))).rejects.toThrow('absolute');
  });
});
