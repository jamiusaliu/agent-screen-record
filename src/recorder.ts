import fs from 'node:fs'; import path from 'node:path';
import { ScreenrecError, errorJson, type ErrorCode } from './core/errors.ts';
import { assertNotWindows, pidExists, signalable } from './core/platform.ts';
import type { Display } from './core/geometry.ts';
import type { Target, WindowInfo } from './core/targets.ts';
import { readState, writeState, clearState, isRecorderAlive, stateDir, ensureStateDir, type RecordingState } from './core/state.ts';
import { appendMark, readMarks, writeSidecar, readSidecar } from './core/sidecar.ts';
import { recordingsDir, defaultRecordingBase, stripExt } from './core/paths.ts';
import * as mac from './capture/mac.ts';
import { resolveEndpoint } from './capture/cdp/endpoint.ts';
import type { WorkerConfig } from './capture/cdp/worker.ts';
import { NO_FRAMES_EXIT, ENCODER_FAILED_EXIT } from './capture/cdp/pacer.ts';
import { superviseSpawn, nodeScriptArgs } from './capture/supervise.ts';
import { chromeActiveTabs, type ChromeActiveTab } from './capture/chrome-applescript.ts';
import { runFfmpeg, probe, requireFfmpeg, requireFfprobe, ENCODE } from './edit/ffmpeg.ts';
import { assertOutFolder, assertOutFree, assertForceHasOut } from './edit/output.ts';

export interface StartOptions {
  target: Target; out?: string; fps: number; cursor: boolean; maxMs: number; meta: boolean; cwd?: string;
  /** With out: replace an existing <out>.mp4 (and sidecar) at stop, once a playable recording exists. */
  force?: boolean;
  /** Called once if the Chrome broker takes long to start (usually the Allow dialog). */
  onAllowWait?: () => void;
}
/**
 * `recovered` is true when stop returns a recording that status or start had already finalised.
 * `warnings` names stretches where the screen was locked, asleep or taken by another session.
 */
export interface StopResult { out: string; durationSec: number; sidecar?: string; reason: string; recovered?: boolean; warnings?: string[] }
export interface StartResult { out: string; pid: number; worker: 'mac' | 'cdp'; target: string; warnings: string[]; recovered?: StopResult }

export interface RecorderDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  isAlive(pid: number): boolean;
  signal(pid: number, sig: NodeJS.Signals): void;
  mac: { listDisplays(): Promise<Display[]>; listWindows(): Promise<WindowInfo[]>; spawnRecord(spec: mac.CaptureSpec, o: mac.RecordOptions): number; ancestorPids(): number[] };
  cdp: { resolveEndpoint(o: { cdp?: string; onWaiting?: () => void }): Promise<{ wsUrl: string }>; spawnWorker(cfg: WorkerConfig, logFile: string): number };
  chromeActiveTabs(): Promise<ChromeActiveTab[]>;
  remux(raw: string, out: string): Promise<void>;
  duration(file: string): Promise<number>;
  /** The checks doctor runs: throws E_NO_FFMPEG when ffmpeg or ffprobe cannot be run. */
  requireFfmpeg(): Promise<unknown>;
}

/** Seconds startRecording waits for the worker to report that capture is running. */
export const READY_TIMEOUT_MS = { mac: 15_000, cdp: 20_000 } as const;  // cdp: longer than the worker's 15 s connect timeout

const DEBUG_FIX = 'Run "screenrec doctor", then retry with SCREENREC_DEBUG=1.';
const WRITER_FIX = 'Check that the output folder exists, is writable and has free disk space, or pass --out to another folder, then try again.';

function spawnRecord(spec: mac.CaptureSpec, o: mac.RecordOptions): number {
  const helper = mac.helperPath();
  try { fs.accessSync(helper, fs.constants.X_OK); }
  catch { throw new ScreenrecError('E_HELPER_CRASHED', `Capture helper not found or not executable at ${helper}`, mac.HELPER_MISSING_FIX); }
  return superviseSpawn(helper, mac.recordArgs(spec, o), o.logFile);
}

function spawnWorker(cfg: WorkerConfig, logFile: string): number {
  const worker = new URL(`./capture/cdp/worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
  // the config goes on stdin, never argv: its wsUrl may carry the broker token
  return superviseSpawn(process.execPath, nodeScriptArgs(worker), logFile, { stdin: JSON.stringify(cfg) + '\n' });
}

async function remux(raw: string, out: string): Promise<void> {
  try { await runFfmpeg(['-v', 'error', '-y', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out]); }
  catch { await runFfmpeg(['-v', 'error', '-y', '-err_detect', 'ignore_err', '-i', raw, '-an', ...ENCODE, out]); }
}

export const realDeps: RecorderDeps = {
  platform: process.platform,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isAlive: (pid) => isRecorderAlive(pid),
  // Workers run under a supervisor that leads its own process group: SIGINT goes to the supervisor,
  // which forwards it; SIGKILL goes to the whole group so no recorder or ffmpeg is left behind.
  signal: (pid, sig) => {
    if (!signalable(pid)) return; // never 0, 1 or below: -0 is our own group and -1 is every process we own
    try { process.kill(sig === 'SIGKILL' ? -pid : pid, sig); }
    catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
  },
  mac: { listDisplays: mac.listDisplays, listWindows: mac.listWindows, spawnRecord, ancestorPids: () => mac.ancestorPids() },
  cdp: { resolveEndpoint: (o) => resolveEndpoint(o), spawnWorker },
  chromeActiveTabs,
  remux,
  duration: async (f) => (await probe(f)).duration,
  requireFfmpeg: async () => { await requireFfmpeg(); await requireFfprobe(); },
};

const logOf = (s: { out: string }) => `${stripExt(s.out)}.rec.log`;

type LogEvent = { event?: string; reason?: unknown; frames?: unknown; screen?: unknown; code?: unknown; signal?: unknown; ok?: unknown; message?: unknown; fix?: unknown };

const KEEP_AWAKE = 'For unattended runs, keep the displays awake, for example with "caffeinate -d" running alongside.';

/** E_NO_FRAMES text for a mac recording whose helper saw the screen locked, asleep or off console (stopped.screen). */
export function screenNoFrames(screen: unknown): { message: string; fix: string } | null {
  if (screen === 'locked') return { message: 'The recording captured no frames: the screen was locked', fix: `Unlock the Mac and record again. ${KEEP_AWAKE}` };
  if (screen === 'asleep') return { message: 'The recording captured no frames: the displays were asleep', fix: `Wake the displays and record again. ${KEEP_AWAKE}` };
  if (screen === 'off-console') return { message: 'The recording captured no frames: another user session was using the screen', fix: "Switch back to this user's session and record again." };
  return null;
}

/** A screen state that draws nothing, as the helper reports it in "screen" events and stopped.screen. */
export type ScreenOff = 'locked' | 'asleep' | 'off-console';
const SCREEN_RANK: Record<ScreenOff, number> = { asleep: 1, locked: 2, 'off-console': 3 };  // ScreenState.rank in the helper

/** One "screen" event from the helper's log: the new state and when, in seconds on the video clock. */
export interface ScreenChange { t: number; state: string }

/**
 * The helper checks the screen once a second, so a stretch is measured in whole seconds, give or take one.
 * A stretch under MIN_GAP_SEC (one check) is noise. One that began before the first frame must reach
 * MIN_START_GAP_SEC: a recording started while locked gets its first frame at the unlock, and the unlock
 * is seen up to a second later, so that is not lost video.
 */
export const MIN_GAP_SEC = 1;
export const MIN_START_GAP_SEC = 1.5;

/**
 * Stretches of the video (seconds) while the screen was not drawn, from the helper's "screen" events,
 * never from mark text (an agent may write the note "screen locked" itself). A stretch still open at
 * the end runs to `durationSec`; times before the first frame count from 0. So a lock shorter than about
 * a second, one that starts within about a second of stop, or one that was on at start and ends within
 * about 1.5 s of the first frame may not be reported.
 */
export function screenGaps(changes: ScreenChange[], durationSec: number): { state: ScreenOff; from: number; to: number }[] {
  const gaps: { state: ScreenOff; from: number; to: number }[] = [];
  let open: { state: ScreenOff; from: number } | null = null;
  const close = (to: number) => {
    const from = Math.max(0, open!.from), end = Math.min(Math.max(0, to), durationSec);
    if (end - from >= (open!.from <= 0 ? MIN_START_GAP_SEC : MIN_GAP_SEC)) gaps.push({ state: open!.state, from, to: end });
    open = null;
  };
  for (const c of [...changes].sort((a, b) => a.t - b.t)) {
    if (c.state in SCREEN_RANK) {
      const st = c.state as ScreenOff;
      if (!open) open = { state: st, from: c.t }; else if (SCREEN_RANK[st] > SCREEN_RANK[open.state]) open.state = st;
    } else if (c.state === 'awake' && open) close(c.t);
  }
  if (open) close(durationSec);
  return gaps;
}

/** "48s", "1m 52s", "1h 0m 5s". */
export function spokenDuration(sec: number): string {
  const t = Math.max(0, Math.round(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}h ${m}m ${x}s` : m ? `${m}m ${x}s` : `${x}s`;
}

/** "0:45", "1:02:03": a position in the video. */
function clock(sec: number): string {
  const t = Math.max(0, Math.round(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

const GAP_WHAT: Record<ScreenOff, string> = { locked: 'the screen was locked', asleep: 'the displays were asleep', 'off-console': 'another user session had the screen' };

/** One stop warning per stretch the screen was not drawn: how long, where in the video, and what it means. */
export function screenGapWarnings(changes: ScreenChange[], durationSec: number): string[] {
  return screenGaps(changes, durationSec).map((g) =>
    `${GAP_WHAT[g.state]} for ${spokenDuration(g.to - g.from)} (${clock(g.from)} to ${clock(g.to)} in the video); that part of the video is frozen or blank`);
}

const SCREEN_NOW: Record<ScreenOff, string> = {
  locked: 'the screen is locked: nothing is being captured until it is unlocked',
  asleep: 'the displays are asleep: nothing is being captured until they wake',
  'off-console': 'another user session is using the screen: nothing is being captured until you switch back',
};

/** The status note for the screen state the helper last reported; null while the screen is drawn. */
export function screenStatusNote(screen: unknown): string | null {
  return typeof screen === 'string' && screen in SCREEN_NOW ? `${SCREEN_NOW[screen as ScreenOff]} (the video holds the last frame meanwhile)` : null;
}

/** The helper's "screen" events, shifted from the recording clock to the video clock like the marks. */
function screenChanges(logFile: string, offsetSec: number): ScreenChange[] {
  const out: ScreenChange[] = [];
  for (const e of logEvents(logFile) as { event?: string; state?: unknown; t?: unknown }[]) {
    if (e.event === 'screen' && typeof e.state === 'string' && typeof e.t === 'number' && Number.isFinite(e.t)) out.push({ t: e.t - offsetSec, state: e.state });
  }
  return out;
}

function logLines(logFile: string): string[] {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; }
}

function logEvents(logFile: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const l of logLines(logFile)) {
    if (!l.startsWith('{')) continue;
    try { out.push(JSON.parse(l) as LogEvent); } catch { /* not JSON */ }
  }
  return out;
}

const lastEvent = (logFile: string, name: string) => logEvents(logFile).reverse().find((e) => e.event === name);

function logTail(logFile: string): string {
  try { return fs.readFileSync(logFile, 'utf8').slice(-400).trim(); } catch { return ''; }
}

function endReason(s: RecordingState): string | null {
  const ev = lastEvent(logOf(s), 'stopped');
  if (typeof ev?.reason === 'string') return ev.reason;
  const m = readMarks(s.marksFile).reverse().find((x) => x.text.startsWith('stopped: '));
  return m ? m.text.slice('stopped: '.length) : null;
}

const isDirectory = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/** First free base name (B, B-2, B-3, ...) whose mp4 (and sidecar, with meta on) does not exist yet. */
function freeBase(base: string, meta: boolean): string {
  for (let i = 1; ; i++) {
    const b = i === 1 ? base : `${base}-${i}`;
    if (!fs.existsSync(`${b}.mp4`) && !(meta && fs.existsSync(`${b}.json`))) return b;
  }
}

/** Video time 0 on mac is the first frame, not the spawn; the CDP pacer counts frames from t0, so 0 there. */
function firstFrameMs(s: RecordingState, log: string): number {
  if (s.worker !== 'mac') return s.startedAt;
  const ff = logEvents(log).find((e) => e.event === 'first-frame');
  const ms = (ff as { ms?: unknown } | undefined)?.ms;
  return typeof ms === 'number' && ms > s.startedAt ? ms : s.startedAt;
}

/**
 * ffmpeg removed while recording: the recording itself is fine, so keep the raw file and the step
 * notes, and say where both are (not "no frames" or "folder not writable").
 */
function noFfmpegKept(e: ScreenrecError, s: RecordingState): ScreenrecError {
  const notes = fs.existsSync(s.marksFile) ? `; step notes kept at ${s.marksFile}` : '';
  return new ScreenrecError(e.code, `${e.message}; raw kept at ${s.raw}${notes}`, `${e.fix} Then convert the kept file, e.g. ffmpeg -i <raw> out.mp4.`);
}

async function keepNoFfmpeg(deps: RecorderDeps, s: RecordingState, log: string, debug: boolean): Promise<void> {
  try { await deps.requireFfmpeg(); } catch (e) {
    if (e instanceof ScreenrecError && e.code === 'E_NO_FFMPEG') { if (!debug) fs.rmSync(log, { force: true }); throw noFfmpegKept(e, s); }
  }
}

async function finalize(s: RecordingState, deps: RecorderDeps, reason: string): Promise<StopResult> {
  clearState(); // first, so a failure below never blocks the next start
  if (s.requests) mac.clearRequests(s.requests);  // the recorder is gone: drop any screenshot it took for a caller
  const log = logOf(s);
  const exitCode = lastEvent(log, 'exit')?.code;
  const stopped = lastEvent(log, 'stopped');
  const t0 = firstFrameMs(s, log);
  const offsetSec = (t0 - s.startedAt) / 1000;
  const marks = readMarks(s.marksFile).map((m) => ({ ...m, t: Math.max(0, Math.round((m.t - offsetSec) * 1000) / 1000) }));
  const debug = process.env.SCREENREC_DEBUG === '1';
  const cleanupAux = () => {
    fs.rmSync(s.marksFile, { force: true });
    if (!debug) fs.rmSync(log, { force: true });
  };
  if (exitCode === ENCODER_FAILED_EXIT) {
    const tail = logTail(log);
    await keepNoFfmpeg(deps, s, log, debug);
    cleanupAux();
    throw new ScreenrecError('E_HELPER_CRASHED', `The recorder could not write the video file; raw kept at ${s.raw}${tail ? `\n${tail}` : ''}`, WRITER_FIX);
  }
  const noFrames = exitCode === NO_FRAMES_EXIT || stopped?.frames === 0 || !fs.existsSync(s.raw) || fs.statSync(s.raw).size === 0;
  if (noFrames) {
    fs.rmSync(s.raw, { force: true });
    cleanupAux();
    const why = screenNoFrames(stopped?.screen);
    if (why) throw new ScreenrecError('E_NO_FRAMES', why.message, why.fix);
    throw new ScreenrecError('E_NO_FRAMES', 'The recording captured no frames',
      'The target never changed on screen or was hidden. Un-minimize it, or for tabs make sure the agent opened one after start.');
  }
  // Remux to a temporary file and check it before it takes the real name: a recorder killed in its
  // first seconds leaves a header-only file that ffmpeg turns into an empty or unplayable mp4.
  const tmp = `${stripExt(s.raw)}.tmp.mp4`;
  let durationSec: number;
  try {
    await deps.remux(s.raw, tmp);
    durationSec = await deps.duration(tmp);
    if (!(durationSec > 0)) throw new Error('no duration');
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e instanceof ScreenrecError && e.code === 'E_NO_FFMPEG') { if (!debug) fs.rmSync(log, { force: true }); throw noFfmpegKept(e, s); }
    cleanupAux();
    throw new ScreenrecError('E_NO_FRAMES', `The recording has no playable frames (the recorder stopped before writing any); raw kept at ${s.raw}`,
      'Record for at least 2 seconds. If it keeps happening, run "screenrec doctor", then retry with SCREENREC_DEBUG=1.');
  }
  // never overwrite a file the user made meanwhile, unless start had --force for this exact --out
  const base = s.force ? stripExt(s.out) : freeBase(stripExt(s.out), s.meta);
  const out = `${base}.mp4`;
  let replaced = false;
  if (s.force) {
    // a folder created at the forced path during recording: never rename onto it, keep the raw file
    const blocked = [out, ...(s.meta ? [`${base}.json`] : [])].find((f) => isDirectory(f));
    if (blocked) {
      fs.rmSync(tmp, { force: true });
      if (!debug) fs.rmSync(log, { force: true });
      const kept = fs.existsSync(s.marksFile) ? ` and its step notes at ${s.marksFile}` : '';
      throw new ScreenrecError('E_BAD_ARGS', `Output is a directory now: ${blocked}; the recording was kept at ${s.raw}${kept}`,
        'Move that folder away and convert the kept file, e.g. ffmpeg -i <kept file> out.mp4, or record again with another --out.');
    }
    replaced = fs.existsSync(out);
  }
  fs.renameSync(tmp, out);
  // --force --no-meta: a screenrec sidecar left next to the replaced recording would describe the old video
  if (replaced && !s.meta && readSidecar(`${base}.json`)?.version === 1) fs.rmSync(`${base}.json`, { force: true });
  let sidecar: string | undefined;
  if (s.meta) {
    sidecar = `${base}.json`;
    writeSidecar(sidecar, { version: 1, target: s.target, startedAt: new Date(t0).toISOString(), durationSec, marks });
  }
  const warnings = s.worker === 'mac' ? screenGapWarnings(screenChanges(log, offsetSec), durationSec) : [];  // before the log goes
  fs.rmSync(s.raw, { force: true });
  cleanupAux();
  return { out, durationSec, sidecar, reason, ...(warnings.length ? { warnings } : {}) };
}

/** Finalises a dead recorder and keeps the outcome in state for the next status, stop or start. */
async function settleDead(s: RecordingState, deps: RecorderDeps): Promise<RecordingState> {
  let next: RecordingState;
  try { next = { ...s, recovered: await finalize(s, deps, endReason(s) ?? 'recovered after a crash or reboot') }; }
  catch (e) { const j = errorJson(e); next = { ...s, recoveryError: { code: j.code, message: j.message, fix: j.fix } }; }
  writeState(next);
  return next;
}


const lockPath = () => path.join(stateDir(), 'start.lock');
const busy = () => new ScreenrecError('E_ALREADY_RECORDING', 'Another "screenrec start" is starting a recording right now', 'Wait for it, then run "screenrec status".');

/** Taken before anything is spawned, so two concurrent starts cannot both spawn a recorder. */
function acquireStartLock(): () => void {
  ensureStateDir();
  const p = lockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(p, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = 0, age = 0;
      try { holder = Number(fs.readFileSync(p, 'utf8')); age = Date.now() - fs.statSync(p).mtimeMs; } catch { continue; }
      if (holder > 0 && pidExists(holder) && age < 10 * 60_000) throw busy();
      fs.rmSync(p, { force: true });  // left by a start that died
    }
  }
  throw busy();
}

/**
 * Waits until the worker says capture is running ("ready" from the CDP worker, {"event":"started"} from
 * the mac helper), so a tab or window the agent opens right after start is seen as new. A setup error
 * line becomes that ScreenrecError; a worker that never gets ready is killed.
 */
async function waitReady(worker: 'mac' | 'cdp', pid: number, logFile: string, deps: RecorderDeps): Promise<void> {
  const until = deps.now() + READY_TIMEOUT_MS[worker];
  for (let lastLook = false; ; ) {
    for (const l of logLines(logFile)) {
      if (worker === 'cdp' && l === 'ready') return;
      if (!l.startsWith('{')) continue;
      let j: LogEvent;
      try { j = JSON.parse(l) as LogEvent; } catch { continue; }
      if (worker === 'mac' && j.event === 'started') return;
      if (j.ok === false && typeof j.code === 'string') {
        const code = j.code as ErrorCode;
        const fix = typeof j.fix === 'string' ? j.fix : mac.HELPER_FIXES[code] ?? DEBUG_FIX;
        throw new ScreenrecError(code, typeof j.message === 'string' ? j.message : 'capture failed to start', fix);
      }
    }
    if (lastLook) {
      const ev = lastEvent(logFile, 'exit');
      const how = ev ? ` (exit ${String(ev.code ?? ev.signal)})` : '';
      const tail = logTail(logFile);
      throw new ScreenrecError('E_HELPER_CRASHED', `The recorder exited before it started${how}${tail ? `: ${tail}` : ''}`, DEBUG_FIX);
    }
    // kill(pid, 0), not ps: this runs every 50 ms. The exit line covers a supervisor not reaped yet.
    if (!pidExists(pid) || lastEvent(logFile, 'exit')) { lastLook = true; continue; }  // read the log once more: the last lines may say why
    if (deps.now() >= until) {
      deps.signal(pid, 'SIGKILL');
      const s = Math.round(READY_TIMEOUT_MS[worker] / 1000);
      if (worker === 'cdp') {
        throw new ScreenrecError('E_CDP_UNAVAILABLE', `Chrome did not let the tab recorder connect within ${s} s`,
          'If Chrome is asking whether to allow remote debugging, click Allow, then try again. Otherwise run "screenrec doctor".');
      }
      throw new ScreenrecError('E_HELPER_CRASHED', `The capture helper did not start within ${s} s`,
        'Look for a macOS Screen Recording dialog and answer it, then try again. Otherwise run "screenrec doctor".');
    }
    await deps.sleep(50);
  }
}

/** An empty, owner-only folder for the recorder's requests (see mac.recorderRoute). */
function requestsDir(): string {
  ensureStateDir();
  const d = mac.requestsFolder();
  fs.rmSync(d, { recursive: true, force: true });  // a crashed recording may have left requests behind
  fs.mkdirSync(d, { mode: 0o700 });
  return d;
}

/**
 * How long the recorder waits after a `windows` listing quit. A screenrec-mac that used ScreenCaptureKit
 * and quit stops the live streams of the same path a moment later (about 0.4 s seen on macOS 26.7), which
 * could hit the new recorder's first stream.
 */
export const LISTING_SETTLE_MS = 1000;

async function startMac(target: Target, base: string, o: StartOptions, deps: RecorderDeps, t0Ms: number, marksFile: string, logFile: string) {
  mac.assertMac(deps.platform);
  // Display and region targets need no window list, so no listing helper quits next to the recorder.
  const needsWindows = target.kind !== 'display' && target.kind !== 'region';
  const [displays, windows] = await Promise.all([deps.mac.listDisplays(), needsWindows ? deps.mac.listWindows() : Promise.resolve([])]);
  const listed = deps.now();  // the listing helper has exited: execFile answers on its exit
  const { spec, label } = mac.resolveCaptureSpec(target, displays, windows, o.cursor);
  if (needsWindows) { const wait = LISTING_SETTLE_MS - (deps.now() - listed); if (wait > 0) await deps.sleep(wait); }
  const raw = `${base}.rec.mov`;
  const follow = (target.kind === 'window' || target.kind === 'app') && target.followApp;
  const ignoreApps = target.kind === 'window' || target.kind === 'app' ? target.ignoreApps : [];
  const requests = requestsDir();
  const pid = deps.mac.spawnRecord(spec, { out: raw, fps: o.fps, maxSeconds: o.maxMs / 1000, followApp: follow, ignoreApps,
    ignorePids: deps.mac.ancestorPids(), marksFile, t0Ms, logFile, requestsDir: requests });
  return { pid, raw, label, requests };
}

/** Longest --max: 24 h. Far longer overflows setTimeout in the tab worker, which then stops at once. */
export const MAX_RECORDING_MS = 24 * 3600_000;

/** Values the helper or worker would refuse or misread, checked here with a fix the user can act on. */
function validateStart(o: StartOptions): void {
  if (!Number.isInteger(o.fps) || o.fps < 1 || o.fps > 120) {
    throw new ScreenrecError('E_BAD_ARGS', `--fps must be a whole number from 1 to 120, got "${String(o.fps)}"`, 'Example: --fps 30 (the default).');
  }
  if (!Number.isFinite(o.maxMs) || o.maxMs < 1000 || o.maxMs > MAX_RECORDING_MS) {
    throw new ScreenrecError('E_BAD_ARGS', `--max must be from 1s to 24h, got ${Number.isFinite(o.maxMs) ? `${o.maxMs / 1000} s` : String(o.maxMs)}`, 'Example: --max 10m (the default), --max 90s or --max 2h.');
  }
  const ext = o.out ? path.extname(o.out) : '';
  if (ext && ext.toLowerCase() !== '.mp4') {
    throw new ScreenrecError('E_BAD_ARGS', `--out must be an .mp4 file, got "${ext}"`, 'Recordings are always mp4: pass --out <name>.mp4. Convert later with ffmpeg if you need another format.');
  }
}

export async function startRecording(o: StartOptions, deps: RecorderDeps = realDeps): Promise<StartResult> {
  assertForceHasOut(o.force, o.out);
  validateStart(o);
  assertNotWindows('Recording', deps.platform);
  // stop needs ffmpeg to finish the file: fail now, not after a whole recording
  await deps.requireFfmpeg();
  // An explicit --out folder must exist, as for every other command; only ./recordings/ is created.
  if (o.out) assertOutFolder(path.resolve(o.out));
  const release = acquireStartLock();
  try { return await startLocked(o, deps); } finally { release(); }
}

async function startLocked(o: StartOptions, deps: RecorderDeps): Promise<StartResult> {
  let recovered: StopResult | undefined;
  const warnings: string[] = [];
  let existing = readState();
  if (existing && !existing.recovered && !existing.recoveryError) {
    if (deps.isAlive(existing.pid)) {
      throw new ScreenrecError('E_ALREADY_RECORDING', `Already recording to ${existing.out}`, 'Run "screenrec stop" first (one recording at a time).');
    }
    existing = await settleDead(existing, deps);
  }
  if (existing) {
    if (existing.recovered) recovered = existing.recovered;
    if (existing.recoveryError) {
      const m = existing.recoveryError.message;
      const kept = m.includes('raw kept at') ? '' : fs.existsSync(existing.raw) ? `; raw kept at ${existing.raw}` : '; no raw file was left';
      warnings.push(`could not recover ${existing.out}: ${m}${kept}`);
    }
    clearState();
  }
  try { return await spawnAndWait(o, deps, warnings, recovered); }
  catch (e) {
    // the earlier recording was saved even though this start failed: say where
    if (recovered && e instanceof ScreenrecError) {
      throw new ScreenrecError(e.code, `${e.message} (an earlier recording was recovered to ${recovered.out})`, e.fix, e.candidates);
    }
    throw e;
  }
}

async function spawnAndWait(o: StartOptions, deps: RecorderDeps, warnings: string[], recovered: StopResult | undefined): Promise<StartResult> {
  let base: string;
  if (o.out) {
    base = stripExt(path.resolve(o.out));
    assertOutFree(`${base}.mp4`, { force: o.force, sidecar: o.meta });
  } else {
    base = freeBase(path.join(recordingsDir(o.cwd), defaultRecordingBase(new Date(deps.now()))), o.meta);
  }
  const out = `${base}.mp4`, marksFile = `${base}.marks.jsonl`, logFile = `${base}.rec.log`, t0Ms = deps.now();
  for (const f of [marksFile, logFile]) fs.rmSync(f, { force: true });
  let pid: number, raw: string, label: string, worker: 'mac' | 'cdp', requests: string | undefined;

  if (o.target.kind === 'tab') {
    const t = o.target;
    try {
      const { wsUrl } = await deps.cdp.resolveEndpoint({ cdp: t.cdp, onWaiting: o.onAllowWait });
      raw = `${base}.rec.mkv`; worker = 'cdp';
      label = `Chrome tab (${t.mode}${t.pattern ? `: ${t.pattern}` : ''})`;
      pid = deps.cdp.spawnWorker({ wsUrl, mode: t.mode, pattern: t.pattern, out: raw, fps: o.fps, maxSeconds: o.maxMs / 1000, marksFile, t0Ms }, logFile);
    } catch (e) {
      const canFallBack = e instanceof ScreenrecError && e.code === 'E_CDP_UNAVAILABLE' && deps.platform === 'darwin' && (t.mode === 'url' || t.mode === 'title');
      const hit = canFallBack
        ? (await deps.chromeActiveTabs()).find((x) => (t.mode === 'url' ? x.url : x.title).toLowerCase().includes(t.pattern!.toLowerCase()))
        : undefined;
      if (!hit) throw e;
      warnings.push(`Chrome remote debugging is off, so this records the Chrome window "${hit.title}" instead of the tab. ` +
        'Covering that window or switching its tab will freeze or change the recording. Enable chrome://inspect/#remote-debugging to record hidden tabs.');
      ({ pid, raw, label, requests } = await startMac({ kind: 'window', app: 'Google Chrome', title: hit.title, followApp: false, ignoreApps: [] }, base, o, deps, t0Ms, marksFile, logFile));
      worker = 'mac';
    }
  } else {
    ({ pid, raw, label, requests } = await startMac(o.target, base, o, deps, t0Ms, marksFile, logFile));
    worker = 'mac';
    if (o.target.kind === 'display' || o.target.kind === 'region' || o.target.kind === 'display-of') {
      warnings.push('Display capture records notifications and every window on that display. Consider turning on a Focus mode, or record a --window instead.');
    }
  }

  writeState({ pid, worker, target: o.target, label, raw, out, marksFile, meta: o.meta, startedAt: t0Ms, maxMs: o.maxMs,
    ...(requests ? { requests } : {}), ...(o.out && o.force ? { force: true } : {}) });
  try { await waitReady(worker, pid, logFile, deps); }
  catch (e) {
    if (pidExists(pid)) deps.signal(pid, 'SIGKILL');
    clearState();
    for (const f of [raw, marksFile]) fs.rmSync(f, { force: true });
    if (process.env.SCREENREC_DEBUG !== '1') fs.rmSync(logFile, { force: true });
    throw e;
  }
  // The mac helper warns before "started" when the screen is locked or asleep (nothing will be captured).
  if (worker === 'mac') {
    for (const ev of logEvents(logFile)) {
      if (ev.event === 'started') break;
      if (ev.event === 'warning' && typeof ev.message === 'string') warnings.push(ev.message);
    }
  }
  return { out, pid, worker, target: label, warnings, recovered };
}

export async function stopRecording(deps: RecorderDeps = realDeps): Promise<StopResult> {
  const s = readState();
  if (!s) throw new ScreenrecError('E_NOT_RECORDING', 'Nothing is recording', 'Start one with "screenrec start --window <App>".');
  if (s.recovered) { clearState(); return { ...s.recovered, recovered: true }; }
  if (s.recoveryError) { clearState(); throw new ScreenrecError(s.recoveryError.code, s.recoveryError.message, s.recoveryError.fix); }
  let reason = endReason(s) ?? 'ended on its own';
  if (deps.isAlive(s.pid)) {
    deps.signal(s.pid, 'SIGINT');
    for (let i = 0; i < 150 && deps.isAlive(s.pid); i++) await deps.sleep(100);
    if (deps.isAlive(s.pid)) { deps.signal(s.pid, 'SIGKILL'); await deps.sleep(500); }
    reason = 'stopped';
  }
  return finalize(s, deps, reason);
}

export interface StatusResult {
  recording: boolean; elapsedSec?: number; out?: string; target?: string; text: string;
  /** Mac recordings only, and only while the screen is not drawn: what the helper last saw. */
  screen?: ScreenOff;
  /** Window and app recordings only: "hidden" while the helper holds the last frame (minimized, hidden or closed). */
  targetState?: 'visible' | 'hidden';
  recovered?: StopResult; recoveryError?: { code: ErrorCode; message: string; fix: string };
}

const HIDDEN_WARNING = 'window is hidden, minimized or closed; holding the last frame';
const VISIBLE_WARNING = 'window is visible again';

/** The recorded window's state from the helper's last hidden/visible warning (a follow switch shows a new window). */
function targetState(s: RecordingState): 'visible' | 'hidden' | undefined {
  if (s.worker !== 'mac' || (s.target.kind !== 'window' && s.target.kind !== 'app')) return undefined;
  for (const ev of logEvents(logOf(s)).reverse()) {
    if (ev.event === 'switched') return 'visible';
    if (ev.event === 'warning' && ev.message === HIDDEN_WARNING) return 'hidden';
    if (ev.event === 'warning' && ev.message === VISIBLE_WARNING) return 'visible';
  }
  return 'visible';
}

/** The screen state from the helper's last "screen" event; undefined while drawn or for tab recordings. */
function screenNow(s: RecordingState): ScreenOff | undefined {
  if (s.worker !== 'mac') return undefined;
  const ev = lastEvent(logOf(s), 'screen') as { state?: unknown } | undefined;
  return typeof ev?.state === 'string' && ev.state in SCREEN_RANK ? ev.state as ScreenOff : undefined;
}

/** Running or idle. A dead recorder is finalised here (spec section 5) and the result kept for the next stop. */
export async function recordingStatus(deps: RecorderDeps = realDeps): Promise<StatusResult> {
  let s = readState();
  if (!s) return { recording: false, text: 'idle' };
  if (!s.recovered && !s.recoveryError) {
    if (deps.isAlive(s.pid)) {
      const elapsedSec = Math.round((deps.now() - s.startedAt) / 100) / 10;
      const state = targetState(s);
      const held = state === 'hidden' ? ' (the window is hidden, minimized or closed: holding its last frame)' : '';
      const screen = screenNow(s);
      const note = screenStatusNote(screen);
      return { recording: true, elapsedSec, out: s.out, target: s.label ?? fallbackLabel(s.target), ...(state ? { targetState: state } : {}),
        ...(screen ? { screen } : {}), text: `recording ${elapsedSec} s to ${s.out}${held}${note ? `; warning: ${note}` : ''}` };
    }
    let release: () => void;
    try { release = acquireStartLock(); } catch { return { recording: false, text: 'a recording is starting' }; }
    try { s = await settleDead(s, deps); } finally { release(); }
  }
  if (s.recovered) {
    const r = s.recovered;
    return { recording: false, recovered: r, out: r.out, text: `not recording: the last recording ended (${r.reason}) and was saved to ${r.out} (${r.durationSec.toFixed(1)} s)` };
  }
  const err = s.recoveryError!;
  return { recording: false, recoveryError: err, text: `not recording: could not recover ${s.out}: ${err.message}` };
}

/** Label for a state written before labels were stored. */
function fallbackLabel(t: Target): string {
  switch (t.kind) {
    case 'window': return [t.app, t.title].filter(Boolean).join(': ') || `window ${t.id}`;
    case 'app': return t.app;
    case 'display': return `display ${t.display}`;
    case 'display-of': return `display of ${t.window}`;
    case 'region': return `region of display ${t.display}`;
    case 'tab': return `Chrome tab (${t.mode}${t.pattern ? `: ${t.pattern}` : ''})`;
  }
}

export function addMark(text: string, deps: RecorderDeps = realDeps): { t: number } {
  const s = readState();
  // a recording that status already finalised is over: a mark now would land in a stray marks file
  if (!s || s.recovered || s.recoveryError) throw new ScreenrecError('E_NOT_RECORDING', 'Nothing is recording', 'Start a recording before adding step notes.');
  const t = Math.round(deps.now() - s.startedAt) / 1000;
  appendMark(s.marksFile, { t, text });
  return { t };
}
