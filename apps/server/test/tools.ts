import { accessSync, constants } from 'node:fs';
import path from 'node:path';

const found = new Map<string, boolean>();

/** True if `name` is an executable on PATH. */
export function hasTool(name: string): boolean {
  let ok = found.get(name);
  if (ok === undefined) {
    ok = (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
      try { accessSync(path.join(dir, name), constants.X_OK); return true; } catch { return false; }
    });
    found.set(name, ok);
  }
  return ok;
}

/**
 * Runs the test only if all external tools are installed (heif-convert, ffmpeg, pdftoppm …);
 * otherwise it passes with a warning. The Linux test container has all of them, so nothing is
 * skipped there.
 */
export function itIfTool(tools: string | string[], name: string, fn: () => Promise<void>, timeout?: number) {
  const list = Array.isArray(tools) ? tools : [tools];
  it(name, async () => {
    const missing = list.filter((t) => !hasTool(t));
    if (missing.length) {
      console.warn(`skipped (missing ${missing.join(', ')}): ${name}`);
      return;
    }
    await fn();
  }, timeout);
}
