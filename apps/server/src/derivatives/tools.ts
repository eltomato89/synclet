import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** The external tool exited non-zero or produced nothing: the input is unusable (no retry). */
export class ToolFailedError extends Error {}
/** The tool ran into its timeout and was killed (retryable). */
export class ToolTimeoutError extends Error {}
/** The binary is not installed (retryable – the deployment may be fixed). */
export class ToolMissingError extends Error {}

export interface ToolOptions {
  /** Binary overrides (tests inject fakes); defaults to the tool name, resolved via PATH. */
  bin?: Partial<Record<ToolName, string>>;
  timeoutMs?: number;
  /** Cap for stdout/stderr (default 1 MiB). */
  maxBuffer?: number;
  /**
   * Output beyond `maxBuffer` is cut off instead of failing: the child is killed and the
   * truncated stdout returned (text extraction only needs a prefix; caps decompression bombs).
   */
  truncateOutput?: boolean;
  /** Non-zero exit codes that still count as success (e.g. unzip's warnings). */
  okExitCodes?: number[];
}

export type ToolName = 'heif-convert' | 'ffmpeg' | 'ffprobe' | 'pdftoppm' | 'pdftotext' | 'unzip';

const DEFAULT_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 1024 * 1024;

/** Demuxers ffmpeg/ffprobe may use: plain containers only (no playlists like HLS/concat that open other files). */
const FFMPEG_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';
const FFMPEG_INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', FFMPEG_FORMATS];

/**
 * Runs a tool with an argument array (never a shell). On timeout the child gets SIGKILL;
 * stdout/stderr are capped by maxBuffer (exceeding it also kills the child).
 */
export function runTool(name: ToolName | string, args: string[], opts: ToolOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const bin = opts.bin?.[name as ToolName] ?? name;
  const timeout = opts.timeoutMs ?? (name === 'ffmpeg' || name === 'ffprobe' ? FFMPEG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer, windowsHide: true, env: { PATH: process.env.PATH ?? '' } }, (err, stdout, stderr) => {
      if (!err) { resolve({ stdout, stderr }); return; }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      // Checked before the timeout case: exceeding maxBuffer also kills the child with SIGKILL.
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        if (opts.truncateOutput) resolve({ stdout, stderr });
        else reject(new ToolFailedError(`${name} produced more than ${maxBuffer} bytes of output`));
        return;
      }
      if (typeof e.code === 'number' && !e.killed && opts.okExitCodes?.includes(e.code)) { resolve({ stdout, stderr }); return; }
      if (e.code === 'ENOENT') reject(new ToolMissingError(`${name} is not installed`));
      else if (e.killed && e.signal === 'SIGKILL') reject(new ToolTimeoutError(`${name} timed out after ${timeout} ms`));
      else reject(new ToolFailedError(`${name} failed: ${String(stderr || e.message).slice(0, 500)}`));
    });
    // No tool ever reads stdin: close it so nothing can wait for input there.
    child.stdin?.on('error', () => undefined).end();
  });
}

async function assertOutput(file: string, tool: string): Promise<string> {
  const ok = await stat(file).then((s) => s.isFile() && s.size > 0, () => false);
  if (!ok) throw new ToolFailedError(`${tool} produced no output`);
  return file;
}

function assertAbs(p: string) {
  // Absolute paths can never be mistaken for options or protocol URLs ("-x", "concat:…").
  if (!path.isAbsolute(p)) throw new Error(`tool input must be absolute: ${p}`);
}

/** HEIC/HEIF → JPEG. Returns the output path. */
export async function heifToJpeg(abs: string, outTmp: string, opts: ToolOptions = {}): Promise<string> {
  assertAbs(abs); assertAbs(outTmp);
  const out = `${outTmp}.jpg`;
  await runTool('heif-convert', ['-q', '90', abs, out], opts);
  return assertOutput(out, 'heif-convert');
}

/** Duration in seconds (null if unknown). */
export async function videoDuration(abs: string, opts: ToolOptions = {}): Promise<number | null> {
  assertAbs(abs);
  const { stdout } = await runTool('ffprobe', ['-v', 'error', ...FFMPEG_INPUT_GUARD, '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs], opts);
  const d = Number.parseFloat(stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** One frame at 10 % of the duration (1 s if unknown, first frame as fallback), at most 1280 px wide (never enlarged). */
export async function videoFrame(abs: string, outTmp: string, opts: ToolOptions = {}): Promise<string> {
  assertAbs(abs); assertAbs(outTmp);
  const out = `${outTmp}.jpg`;
  const duration = await videoDuration(abs, opts);
  const grab = (at: number) => runTool('ffmpeg', [
    '-nostdin', '-v', 'error', ...FFMPEG_INPUT_GUARD, '-ss', at.toFixed(3), '-i', abs,
    '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-an', '-sn', '-dn', '-y', out,
  ], opts);
  await grab(duration ? duration * 0.1 : 1);
  if (!(await stat(out).then((s) => s.size > 0, () => false))) await grab(0);
  return assertOutput(out, 'ffmpeg');
}

/**
 * First PDF page as JPEG. `-scale-to 1024` caps the bitmap's long edge so a hostile page size
 * (e.g. 200 x 200 inches) cannot make pdftoppm render a gigapixel bitmap at 110 dpi.
 */
export async function pdfFirstPage(abs: string, outTmp: string, opts: ToolOptions = {}): Promise<string> {
  assertAbs(abs); assertAbs(outTmp);
  await runTool('pdftoppm', ['-f', '1', '-l', '1', '-r', '110', '-scale-to', '1024', '-jpeg', '-singlefile', abs, outTmp], opts);
  return assertOutput(`${outTmp}.jpg`, 'pdftoppm');
}

/** PDF text of the first 50 pages (layout preserved) on stdout, cut off after `maxBytes`. */
export async function pdfText(abs: string, maxBytes: number, opts: ToolOptions = {}): Promise<string> {
  assertAbs(abs);
  const { stdout } = await runTool('pdftotext', ['-q', '-layout', '-l', '50', '-enc', 'UTF-8', abs, '-'], { maxBuffer: maxBytes, truncateOutput: true, ...opts });
  return stdout;
}

/**
 * Concatenated contents of the zip members matching `members` (unzip's own wildcard syntax, no
 * shell involved), cut off after `maxBytes` – a decompression bomb only ever yields that much.
 */
export async function unzipMembers(abs: string, members: string[], maxBytes: number, opts: ToolOptions = {}): Promise<string> {
  assertAbs(abs);
  // 1 = warnings, 11 = some pattern matched no member: whatever was found is still usable.
  // `-P ''`: an encrypted member fails at once (exit 82) instead of unzip prompting on /dev/tty.
  const { stdout } = await runTool('unzip', ['-p', '-qq', '-P', '', abs, ...members], { maxBuffer: maxBytes, truncateOutput: true, okExitCodes: [1, 11], ...opts });
  return stdout;
}
