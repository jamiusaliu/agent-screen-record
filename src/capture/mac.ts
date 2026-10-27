import fs from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ScreenrecError, type ErrorCode } from '../core/errors.ts';
import { WINDOWS_FIX } from '../core/platform.ts';
import { displayOfRect, resolveDisplay, regionToPixels, pixelSize, type Display, type Rect } from '../core/geometry.ts';
import { matchWindow, frontWindowOfApp, parseWindowSelector, type Target, type WindowInfo } from '../core/targets.ts';

const exec = promisify(execFile);

export function assertMac(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') {
    throw new ScreenrecError('E_UNSUPPORTED_PLATFORM', `Window, display and region capture are macOS-only in v1 (this is ${platform})`,
      platform === 'win32' ? WINDOWS_FIX : 'Use --tab to record a Chrome tab (unverified on this platform), or record on a Mac.');
  }
}

export function helperPath(): string {
  return process.env.SCREENREC_MAC_HELPER ?? fileURLToPath(new URL('../../bin/screenrec-mac', import.meta.url));
}

export const HELPER_MISSING_FIX = 'Run "npm run build:native" (from source) or reinstall agent-screen-record (npm i -g agent-screen-record).';

export const OUTPUT_FOLDER_FIX = 'Check that the output folder exists and is writable and that the disk is not full, then try again.';

/** Exit codes of `screenrec-mac record` (see the usage block in native/macos/Sources/screenrec-mac/main.swift). */
export const HELPER_EXIT = { ok: 0, failed: 1, noFrames: 5, writerFailed: 6 } as const;

export const HELPER_FIXES: Partial<Record<ErrorCode, string>> = {
  E_PERMISSION: 'Open System Settings > Privacy & Security > Screen Recording, enable the app that runs screenrec (your terminal or IDE), then quit and reopen that app.',
  E_TARGET_NOT_FOUND: 'Run "screenrec list windows" or "screenrec list displays" and try again.',
  E_NO_FRAMES: 'The target showed no content: un-minimize the window or move it to the current Space.',
  E_HELPER_CRASHED: 'Re-run with SCREENREC_DEBUG=1 and report the output.',
  E_BAD_ARGS: 'This is a screenrec bug; please report it with SCREENREC_DEBUG=1 output.',
};

export const HELPER_TIMEOUT_MS = 30_000;

export async function helperJson<T>(args: string[], timeoutMs = HELPER_TIMEOUT_MS): Promise<T> {
  let stdout = '';
  let failure = '';
  try { stdout = (await exec(helperPath(), args, { maxBuffer: 16 << 20, timeout: timeoutMs })).stdout; }
  catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new ScreenrecError('E_HELPER_CRASHED', `Helper not found at ${helperPath()}`, HELPER_MISSING_FIX);
    if (err.killed) {
      throw new ScreenrecError('E_HELPER_CRASHED', `helper did not answer within ${Math.round(timeoutMs / 1000)} s (a macOS permission dialog may be waiting)`,
        'Look for a Screen Recording dialog and answer it, then try again.');
    }
    stdout = err.stdout ?? '';
    failure = ` (${err.code ?? 'exit'}: ${err.message.split('\n')[0]})`;
  }
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let j: { ok: boolean; code?: ErrorCode; message?: string; fix?: string } & T;
  try { j = JSON.parse(last); } catch {
    throw new ScreenrecError('E_HELPER_CRASHED', `Helper printed no JSON${failure}: ${stdout.slice(0, 200)}`, 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  }
  if (!j.ok) {
    const code = j.code ?? 'E_HELPER_CRASHED';
    throw new ScreenrecError(code, j.message ?? 'helper failed', j.fix ?? HELPER_FIXES[code] ?? 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  }
  return j;
}

export const listDisplays = async () => (await helperJson<{ displays: Display[] }>(['displays'])).displays;
export const listWindows = async () => (await helperJson<{ windows: WindowInfo[] }>(['windows'])).windows;
export const permission = async (request = false) =>
  (await helperJson<{ granted: boolean }>(request ? ['permission', '--request'] : ['permission'])).granted;

export interface CaptureSpec { windowId?: number; displayId?: number; regionPt?: Rect; sizePx: { width: number; height: number }; cursor: boolean }

function windowSpec(w: WindowInfo, displays: Display[], cursor: boolean): CaptureSpec {
  const d = displayOfRect(displays, w);
  return { windowId: w.id, sizePx: pixelSize(w.width, w.height, d.scale), cursor };
}

export function resolveCaptureSpec(target: Target, displays: Display[], windows: WindowInfo[], cursor: boolean): { spec: CaptureSpec; label: string } {
  switch (target.kind) {
    case 'window': { const w = matchWindow(windows, target); return { spec: windowSpec(w, displays, cursor), label: `${w.app}: ${w.title}` }; }
    case 'app': { const w = frontWindowOfApp(windows, target.app); return { spec: windowSpec(w, displays, cursor), label: `${w.app}: ${w.title}` }; }
    case 'display': { const d = resolveDisplay(displays, target.display); return { spec: { displayId: d.id, sizePx: pixelSize(d.width, d.height, d.scale), cursor }, label: d.name }; }
    case 'display-of': {
      const d = displayOfRect(displays, matchWindow(windows, parseWindowSelector(target.window)));
      return { spec: { displayId: d.id, sizePx: pixelSize(d.width, d.height, d.scale), cursor }, label: d.name };
    }
    case 'region': {
      const d = resolveDisplay(displays, target.display);
      const px = regionToPixels(d, target.region);
      return { spec: { displayId: d.id, regionPt: target.region, sizePx: { width: px.width, height: px.height }, cursor }, label: `${d.name} region` };
    }
    case 'tab':
      throw new ScreenrecError('E_BAD_ARGS', 'Tab targets are recorded through Chrome, not the macOS helper', 'This is a screenrec bug; please report it.');
  }
}

export function captureArgs(spec: CaptureSpec): string[] {
  const a: string[] = [];
  if (spec.windowId !== undefined) a.push('--window-id', String(spec.windowId));
  if (spec.displayId !== undefined) a.push('--display-id', String(spec.displayId));
  if (spec.regionPt) a.push('--region', [spec.regionPt.x, spec.regionPt.y, spec.regionPt.width, spec.regionPt.height].join(','));
  a.push('--size', `${spec.sizePx.width},${spec.sizePx.height}`);
  if (spec.cursor) a.push('--cursor');
  return a;
}

export async function screenshot(spec: CaptureSpec, out: string) {
  return helperJson<{ out: string; width: number; height: number }>(['screenshot', ...captureArgs(spec), '--out', out]);
}

function ppid(pid: number): number | null {
  try { const v = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); return Number.isFinite(v) ? v : null; }
  catch { return null; }
}

export function ancestorPids(pid: number = process.pid, ppidOf: (pid: number) => number | null = ppid): number[] {
  const out: number[] = [];
  for (let p = ppidOf(pid); p !== null && p > 1 && out.length < 64; p = ppidOf(p)) out.push(p);
  return out;
}

export interface RecordOptions {
  out: string; fps: number; maxSeconds: number; followApp: boolean; ignoreApps: string[];
  ignorePids: number[]; marksFile: string; t0Ms: number; logFile: string;
}

export function recordArgs(spec: CaptureSpec, o: RecordOptions): string[] {
  return ['record', ...captureArgs(spec), '--fps', String(o.fps), '--out', o.out, '--max-seconds', String(o.maxSeconds),
    '--marks', o.marksFile, '--t0-ms', String(o.t0Ms),
    ...(o.followApp ? ['--follow-app'] : []),
    ...o.ignoreApps.flatMap((a) => ['--ignore-app', a]),
    ...o.ignorePids.flatMap((p) => ['--ignore-pid', String(p)])];
}

export function spawnRecord(spec: CaptureSpec, o: RecordOptions): number {
  const log = fs.openSync(o.logFile, 'a');
  let p;
  try { p = spawn(helperPath(), recordArgs(spec, o), { detached: true, stdio: ['ignore', log, log] }); }
  finally { fs.closeSync(log); }  // the child keeps its own copy of the descriptor
  // A missing or non-executable helper emits 'error' on the next tick; unheard, it would crash the host.
  p.once('error', () => {});
  p.unref();
  if (!p.pid) throw new ScreenrecError('E_HELPER_CRASHED', `Could not start the capture helper at ${helperPath()}`, HELPER_MISSING_FIX);
  return p.pid;
}

/** The error for a finished `record` helper's exit code, or null for success. The stop path uses it. */
export function recordExitError(code: number | null): ScreenrecError | null {
  if (code === HELPER_EXIT.ok) return null;
  if (code === HELPER_EXIT.noFrames) return new ScreenrecError('E_NO_FRAMES', 'The recording captured no frames', HELPER_FIXES.E_NO_FRAMES!);
  if (code === HELPER_EXIT.writerFailed) return new ScreenrecError('E_HELPER_CRASHED', 'The capture helper could not write the video file', OUTPUT_FOLDER_FIX);
  return new ScreenrecError('E_HELPER_CRASHED', `The capture helper exited with code ${code}`, HELPER_FIXES.E_HELPER_CRASHED!);
}
