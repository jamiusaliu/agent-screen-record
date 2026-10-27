import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Target } from './targets.ts';
import type { ErrorCode } from './errors.ts';
import { pidExists } from './platform.ts';

export interface RecordingState {
  pid: number; worker: 'mac' | 'cdp'; target: Target; raw: string; out: string;
  marksFile: string; meta: boolean; startedAt: number; maxMs: number;
  /** Human label of the target, e.g. "Finder: Downloads" (states written before it existed lack it). */
  label?: string;
  /** start had --force with --out: stop replaces an existing out (and sidecar) instead of picking a -2 name. */
  force?: boolean;
  /** Set once a dead recorder has been finalised (by status or start); the next stop or start reports it. */
  recovered?: { out: string; durationSec: number; sidecar?: string; reason: string };
  /** Set when finalising a dead recorder failed; the next stop throws it, the next start warns with it. */
  recoveryError?: { code: ErrorCode; message: string; fix: string };
}

export function stateDir(): string { return process.env.SCREENREC_HOME ?? path.join(os.homedir(), '.screenrec'); }
export function statePath(): string { return path.join(stateDir(), 'state.json'); }

/** Creates the state folder owner-only: it holds window titles, tab patterns and the broker token file. */
export function ensureStateDir(): string {
  const d = stateDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function readState(): RecordingState | null {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as RecordingState; } catch { return null; }
}

export function writeState(s: RecordingState): void {
  ensureStateDir();
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);  // in case a stale temp file existed with other bits
  fs.renameSync(tmp, statePath());
}

export function clearState(): void { fs.rmSync(statePath(), { force: true }); }

export function psCommandLine(pid: number): string | null {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

export function isRecorderAlive(pid: number, psCommand: (pid: number) => string | null = psCommandLine, platform: NodeJS.Platform = process.platform): boolean {
  // Windows has no ps: a missing command line must not read as "dead", or status would finalise a live
  // recording. Fall back to whether the pid exists (start refuses win32, so this is belt and braces).
  if (platform === 'win32') return pidExists(pid);
  const cmd = psCommand(pid);
  return cmd !== null && /screenrec-mac|capture\/cdp\/worker\./.test(cmd);
}
