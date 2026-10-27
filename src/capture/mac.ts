import fs from 'node:fs'; import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ScreenrecError, type ErrorCode } from '../core/errors.ts';
import { WINDOWS_FIX } from '../core/platform.ts';
import { displayOfRect, resolveDisplay, regionToPixels, pixelSize, type Display, type Rect } from '../core/geometry.ts';
import { matchWindow, frontWindowOfApp, parseWindowSelector, type Target, type WindowInfo } from '../core/targets.ts';
import { readState, isRecorderAlive, stateDir } from '../core/state.ts';

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

const KEEP_AWAKE = 'For unattended runs, keep the displays awake, for example with "caffeinate -d" running alongside.';

/** What a screen state that draws nothing means and how to fix it (the helper's `screen` values); null when awake or unknown. */
export function screenNote(screen: unknown): { what: string; fix: string } | null {
  if (screen === 'locked') return { what: 'the screen is locked', fix: `Unlock the Mac and try again. ${KEEP_AWAKE}` };
  if (screen === 'asleep') return { what: 'the displays are asleep', fix: `Wake the displays (move the mouse or press a key) and try again. ${KEEP_AWAKE}` };
  if (screen === 'off-console') return { what: 'another user session is using the screen', fix: "Switch back to this user's session and try again." };
  return null;
}

/**
 * The error for a helper that did not answer within `seconds`. ScreenCaptureKit can stall while the
 * screen is locked or asleep, so that state, when the helper reports it, is named instead of the
 * permission-dialog guess.
 */
export function helperTimeoutError(seconds: number, screen: unknown): ScreenrecError {
  const note = screenNote(screen);
  if (note) return new ScreenrecError('E_TARGET_NOT_FOUND', `helper did not answer within ${seconds} s: ${note.what}, and nothing can be captured until that changes`, note.fix);
  return new ScreenrecError('E_HELPER_CRASHED', `helper did not answer within ${seconds} s (a macOS permission dialog may be waiting)`,
    'Look for a Screen Recording dialog and answer it, then try again.');
}

/**
 * The error for a running recorder that did not answer within `seconds` (it answers within 20 s itself, so
 * this means it is stuck): the screen state when that explains it, never the permission-dialog guess.
 */
export function recorderTimeoutError(seconds: number, screen: unknown): ScreenrecError {
  const note = screenNote(screen);
  if (note) return new ScreenrecError('E_TARGET_NOT_FOUND', `the running recorder did not answer within ${seconds} s: ${note.what}, and nothing can be captured until that changes`, note.fix);
  return new ScreenrecError('E_HELPER_CRASHED', `the running recorder did not answer within ${seconds} s`,
    'Try again. If it keeps happening, stop the recording ("screenrec stop"), then run "screenrec doctor" and retry with SCREENREC_DEBUG=1.');
}

/** Commands a running mac recorder answers itself (native/macos/Sources/screenrec-mac/Requests.swift). */
const SERVED = new Set(['windows', 'screenshot']);

/** The folder a mac recorder answers requests in (one recording at a time, so always the same). */
export const requestsFolder = () => path.join(stateDir(), 'requests');

/** A live mac recorder's request folder, and whether that recorder is still running. */
export interface RecorderRoute { dir: string; alive(): boolean }

/**
 * Where `windows` and `screenshot` go while a mac recording runs. Another screenrec-mac process that uses
 * ScreenCaptureKit and quits stops the recorder's stream ("application connection interrupted"; the
 * recording froze and the screenshot got no frame), so the recorder answers them itself.
 */
export function recorderRoute(): RecorderRoute | null {
  const s = readState();
  if (!s || s.recovered || s.recoveryError || s.worker !== 'mac' || !s.requests || !isRecorderAlive(s.pid)) return null;
  return { dir: s.requests, alive: () => isRecorderAlive(s.pid) };
}

let requestSeq = 0;

/**
 * Sends `args` to the recorder and returns the line it answers. Null when the recorder is gone before it
 * answers (the caller then runs the helper itself); throws the timeout error after `timeoutMs`.
 */
export async function askRecorder(route: RecorderRoute, args: string[], timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), now: () => number = Date.now): Promise<string | null> {
  const id = `${process.pid}-${now()}-${++requestSeq}`;
  const req = path.join(route.dir, `${id}.req`), res = path.join(route.dir, `${id}.res`);
  try {
    fs.writeFileSync(`${req}.tmp`, JSON.stringify({ args }), { mode: 0o600 });
    fs.renameSync(`${req}.tmp`, req);  // the recorder only picks up whole requests
  } catch {  // the folder is gone or unusable: run the helper as usual
    fs.rmSync(`${req}.tmp`, { force: true });
    return null;
  }
  const until = now() + timeoutMs;
  for (let n = 0; ; n++) {
    if (fs.existsSync(res)) { const text = fs.readFileSync(res, 'utf8'); fs.rmSync(res, { force: true }); return text; }
    // checked every 0.5 s, not every poll: it runs ps
    if (n % 10 === 9 && !route.alive()) { fs.rmSync(req, { force: true }); return null; }
    if (now() >= until) { fs.rmSync(req, { force: true }); throw recorderTimeoutError(Math.round(timeoutMs / 1000), await screenState()); }
    await sleep(50);
  }
}

export async function helperJson<T>(args: string[], timeoutMs = HELPER_TIMEOUT_MS,
  route: RecorderRoute | null = SERVED.has(args[0]) ? recorderRoute() : null): Promise<T> {
  let stdout = '';
  let failure = '';
  const answered = route ? await askRecorder(route, args, timeoutMs) : null;
  if (answered !== null) stdout = answered;
  else try { stdout = (await exec(helperPath(), args, { maxBuffer: 16 << 20, timeout: timeoutMs })).stdout; }
  catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new ScreenrecError('E_HELPER_CRASHED', `Helper not found at ${helperPath()}`, HELPER_MISSING_FIX);
    // `screen` itself never asks for the screen state, so a stuck helper cannot recurse
    if (err.killed) throw helperTimeoutError(Math.round(timeoutMs / 1000), args[0] === 'screen' ? null : await screenState());
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

/** The screen state from the helper ("awake", "locked", "asleep" or "off-console"); null when it cannot tell. No ScreenCaptureKit call. */
export const screenState = async (timeoutMs = 5000): Promise<string | null> =>
  (await helperJson<{ screen: string }>(['screen'], timeoutMs).catch(() => null))?.screen ?? null;

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

/**
 * One PNG at `out` (a temp file the caller publishes). A running recorder writes it into its request
 * folder instead, whatever --out says; it is moved to `out` here, never over an existing file.
 */
export async function screenshot(spec: CaptureSpec, out: string) {
  const r = await helperJson<{ out: string; width: number; height: number }>(['screenshot', ...captureArgs(spec), '--out', out]);
  if (r.out !== out) { takeServedPng(r.out, out); r.out = out; }
  return r;
}

/**
 * Moves a recorder-written PNG (only from the request folder) to `out`, which must not exist yet. The
 * new file gets the usual mode (0666 less the umask), like any other screenshot; the recorder's 0600
 * copy is removed whatever happens.
 */
export function takeServedPng(from: string, out: string, dir: string = requestsFolder()): void {
  if (path.dirname(from) !== dir || !/^[\w.-]+\.png$/.test(path.basename(from))) {
    throw new ScreenrecError('E_HELPER_CRASHED', `The recorder answered with an unexpected file: ${from}`, 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  }
  try { fs.writeFileSync(out, fs.readFileSync(from), { flag: 'wx' }); }  // wx: never replaces, never follows a link
  finally { fs.rmSync(from, { force: true }); }
}

/** Empties the request folder: no screenshot a recorder took for someone outlives its recording. */
export function clearRequests(dir: string = requestsFolder()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
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
  /** Folder the recorder answers `windows` and `screenshot` requests in (see recorderRoute). */
  requestsDir?: string;
}

export function recordArgs(spec: CaptureSpec, o: RecordOptions): string[] {
  return ['record', ...captureArgs(spec), '--fps', String(o.fps), '--out', o.out, '--max-seconds', String(o.maxSeconds),
    '--marks', o.marksFile, '--t0-ms', String(o.t0Ms),
    ...(o.followApp ? ['--follow-app'] : []),
    ...o.ignoreApps.flatMap((a) => ['--ignore-app', a]),
    ...o.ignorePids.flatMap((p) => ['--ignore-pid', String(p)]),
    ...(o.requestsDir ? ['--requests', o.requestsDir] : [])];
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
