// Find, start and stop the Chrome broker (see broker.ts).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateDir, psCommandLine } from '../../core/state.ts';
import { ScreenrecError } from '../../core/errors.ts';
import { assertNotWindows, pidExists, safeKill } from '../../core/platform.ts';
import { brokerUrl, allowTimeoutMs, DEFAULT_BROKER_IDLE_MS, type BrokerInfo, type BrokerOptions } from './broker.ts';

/** The broker waits allowTimeoutMs for Chrome; we wait a little longer so its own error line wins. */
export function brokerReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number { return allowTimeoutMs(env) + 5000; }
/** After this long, tell the user we are waiting for them (usually Chrome's Allow dialog). */
export const ALLOW_NOTICE_MS = 2000;

export interface BrokerDeps {
  infoPath?: string;
  alive?: (pid: number) => boolean;
  spawn?: (cfg: BrokerOptions) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  idleMs?: number;
  onWaiting?: () => void;
  noticeMs?: number;
  /** Whether the process holding the start lock is still that process (pid and command line). */
  lockAlive?: (pid: number, cmd: string) => boolean;
  /** Whether the broker a lock holder spawned is still alive (default: the same check as `alive`). */
  brokerAlive?: (pid: number) => boolean;
  /** Defaults to process.platform; the broker is refused on win32. */
  platform?: NodeJS.Platform;
}

export function brokerInfoPath(): string { return path.join(stateDir(), 'chrome-broker.json'); }

export function brokerIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SCREENREC_BROKER_IDLE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BROKER_IDLE_MS;
}

export function isBrokerAlive(pid: number, psCommand: (pid: number) => string | null = psCommandLine, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return pidExists(pid); // no ps there: never call a live broker dead
  const cmd = psCommand(pid);
  return cmd !== null && /capture\/cdp\/broker\./.test(cmd);
}

function readInfo(infoPath: string): BrokerInfo | null {
  try {
    const i = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as BrokerInfo;
    return Number.isInteger(i.pid) && Number.isInteger(i.port) && typeof i.token === 'string' && typeof i.upstream === 'string' ? i : null;
  } catch { return null; }
}

function defaultSpawn(cfg: BrokerOptions): ChildProcess {
  // run the same flavour as this module: built .js, or .ts under tsx in development and tests
  const ts = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(ts ? './broker.ts' : './broker.js', import.meta.url));
  const child = nodeSpawn(process.execPath, [...(ts ? ['--import', 'tsx'] : []), entry],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  // config on stdin, never argv: ps would show Chrome's browser id to every local user
  child.stdin!.on('error', () => {});
  child.stdin!.end(JSON.stringify(cfg) + '\n');
  return child;
}

const NOT_READY_FIX = "Click Allow in Chrome's remote-debugging dialog (chrome://inspect/#remote-debugging), then retry. Re-run with SCREENREC_DEBUG=1 for details.";

function waitReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // let the broker live on its own: drop our pipes and handle
      child.stdout?.removeAllListeners('data'); child.stderr?.removeAllListeners('data');
      child.stdout?.destroy(); child.stderr?.destroy();
      child.unref();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new ScreenrecError('E_CDP_UNAVAILABLE', 'The Chrome broker did not get ready in time', NOT_READY_FIX)); }, timeoutMs);
    child.stdout?.on('data', (d) => { if (String(d).includes('ready')) finish(); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => finish(new ScreenrecError('E_CDP_UNAVAILABLE', `Could not start the Chrome broker: ${e.message}`, NOT_READY_FIX)));
    // 'close', not 'exit': it fires after stderr has been read to the end, so the error line is complete
    child.on('close', () => {
      const line = stderr.trim().split('\n').filter(Boolean).at(-1);
      try {
        const j = JSON.parse(line ?? '');
        if (j && j.ok === false && j.code) return finish(new ScreenrecError(j.code, j.message, j.fix, j.candidates));
      } catch { /* not a JSON error line */ }
      finish(new ScreenrecError('E_CDP_UNAVAILABLE', 'The Chrome broker exited before it was ready', NOT_READY_FIX));
    });
  });
}

interface StartLock { pid: number; at: number; cmd: string; nonce: string; brokerPid?: number }
const lockPathFor = (infoPath: string) => path.join(path.dirname(infoPath), 'chrome-broker.lock');
/** Holder alive: same pid with the same command line. If the command line could not be read when the
 *  lock was taken (stored empty), fall back to "the pid exists"; the lock's age bound limits pid reuse. */
const defaultLockAlive = (pid: number, cmd: string) => {
  if (!cmd) return pidExists(pid);
  const now = psCommandLine(pid);
  return now !== null && now === cmd;
};

/** O_EXCL lock around check-and-spawn, so two callers never start two brokers (two Allow dialogs). */
function tryLock(p: string): StartLock | null {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const lock: StartLock = { pid: process.pid, at: Date.now(), cmd: psCommandLine(process.pid) ?? '', nonce: crypto.randomBytes(8).toString('hex') };
  try { fs.writeFileSync(p, JSON.stringify(lock), { flag: 'wx', mode: 0o600 }); return lock; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null; throw e; }
}

function readLock(p: string): StartLock | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as StartLock; } catch { return null; }
}
const stillMine = (p: string, mine: StartLock) => readLock(p)?.nonce === mine.nonce;

/** Rewrite our own lock (same nonce) with the broker's pid, so a waiter treats it as alive even if we die. */
function recordBrokerPid(p: string, mine: StartLock, brokerPid: number | undefined): void {
  if (!brokerPid || !stillMine(p, mine)) return;
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...mine, brokerPid }), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function releaseLock(p: string, mine: StartLock): void {
  if (stillMine(p, mine)) fs.rmSync(p, { force: true });
}

/**
 * The raw lock content when the lock is stale, else null. Stale: older than the timeout, or its holder
 * is gone and so is the broker it spawned (a holder killed during the Allow wait leaves its broker
 * still waiting; that broker keeps the lock alive).
 */
function staleLock(p: string, timeoutMs: number, lockAlive: (pid: number, cmd: string) => boolean, brokerAlive: (pid: number) => boolean): string | null {
  let raw: string; let mtime: number;
  try { raw = fs.readFileSync(p, 'utf8'); mtime = fs.statSync(p).mtimeMs; } catch { return null; /* released meanwhile: retry */ }
  let l: StartLock;
  try { l = JSON.parse(raw) as StartLock; } catch { return Date.now() - mtime > 2000 ? raw : null; /* half-written, or garbage left behind */ }
  if (!(Date.now() - l.at <= timeoutMs)) return raw;
  if (lockAlive(l.pid, l.cmd)) return null;
  if (l.brokerPid && brokerAlive(l.brokerPid)) return null;
  return raw;
}

/**
 * Compare-and-swap break: move the lock aside, and delete it only if it is still exactly the lock we
 * judged stale. If another caller replaced it meanwhile, put theirs back (link fails if yet another
 * lock is already in place, which then wins).
 */
function breakLock(p: string, judged: string): void {
  const aside = `${p}.break-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(p, aside); } catch { return; /* already gone */ }
  let now = '';
  try { now = fs.readFileSync(aside, 'utf8'); } catch { /* unreadable: treat as changed */ }
  if (now !== judged) { try { fs.linkSync(aside, p); } catch { /* a newer lock exists */ } }
  fs.rmSync(aside, { force: true });
}

/** Reuse a live broker for this upstream, or start one and wait for it. */
export async function ensureBroker(upstream: string, deps: BrokerDeps = {}): Promise<{ wsUrl: string; started: boolean }> {
  assertNotWindows('Using your own Chrome through the screenrec broker', deps.platform);
  const infoPath = deps.infoPath ?? brokerInfoPath();
  const alive = deps.alive ?? ((pid: number) => isBrokerAlive(pid));
  const reuse = () => {
    const i = readInfo(infoPath);
    return i && i.upstream === upstream && alive(i.pid) ? { wsUrl: brokerUrl(i), started: false } : null;
  };
  const found = reuse();
  if (found) return found;
  const timeoutMs = deps.timeoutMs ?? brokerReadyTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const lockPath = lockPathFor(infoPath);
  const notice = setTimeout(() => deps.onWaiting?.(), deps.noticeMs ?? ALLOW_NOTICE_MS);
  try {
    for (;;) {
      const mine = tryLock(lockPath);
      if (mine) {
        try {
          const again = reuse();  // another caller may have finished between our check and the lock
          if (again) return again;
          if (!stillMine(lockPath, mine)) continue;  // broken by a waiter that misjudged it: start over
          // A broker for another upstream is left running: it may be serving a recording, and it
          // exits on its own when its Chrome closes or it idles out. The new one replaces the file.
          const child = (deps.spawn ?? defaultSpawn)({ upstream, idleMs: deps.idleMs ?? brokerIdleMs(), infoPath });
          recordBrokerPid(lockPath, mine, child.pid);
          await waitReady(child, Math.max(1, deadline - Date.now()));
          const info = readInfo(infoPath);
          if (!info || info.upstream !== upstream) {
            throw new ScreenrecError('E_CDP_UNAVAILABLE', 'The Chrome broker started but its info file is missing', NOT_READY_FIX);
          }
          return { wsUrl: brokerUrl(info), started: true };
        } finally { releaseLock(lockPath, mine); }
      }
      // another screenrec is starting the broker: wait for its info file
      const theirs = reuse();
      if (theirs) return theirs;
      if (Date.now() >= deadline) {
        throw new ScreenrecError('E_CDP_UNAVAILABLE', 'Another screenrec is starting the Chrome broker and it did not get ready in time', NOT_READY_FIX);
      }
      const judged = staleLock(lockPath, timeoutMs, deps.lockAlive ?? defaultLockAlive, deps.brokerAlive ?? alive);
      if (judged !== null) { breakLock(lockPath, judged); continue; }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally { clearTimeout(notice); }
}

export function brokerStatus(deps: Pick<BrokerDeps, 'infoPath' | 'alive'> = {}): BrokerInfo | null {
  const info = readInfo(deps.infoPath ?? brokerInfoPath());
  return info && (deps.alive ?? ((pid: number) => isBrokerAlive(pid)))(info.pid) ? info : null;
}

/** Stop the broker. Returns false when none was running (a stale info file is removed). */
export async function stopBroker(deps: Pick<BrokerDeps, 'infoPath' | 'alive' | 'kill'> = {}): Promise<boolean> {
  const infoPath = deps.infoPath ?? brokerInfoPath();
  const alive = deps.alive ?? ((pid: number) => isBrokerAlive(pid));
  const kill = deps.kill ?? safeKill;
  const info = readInfo(infoPath);
  if (!info || !alive(info.pid)) { fs.rmSync(infoPath, { force: true }); return false; }
  try { kill(info.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
  for (let i = 0; i < 60 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 50));
  // the broker removes its own file; clear it if it is still there and still names that broker
  if (readInfo(infoPath)?.token === info.token) fs.rmSync(infoPath, { force: true });
  return true;
}
