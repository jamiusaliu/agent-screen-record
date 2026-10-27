import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { ScreenrecError } from '../core/errors.ts';
import { stripExt } from '../core/paths.ts';
import { writeSidecar, type Sidecar } from '../core/sidecar.ts';
import { stopFfmpegChildren } from './ffmpeg.ts';

const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * A path as ffmpeg must see it: never a URL, always absolute. ffmpeg reads a "proto:" prefix (tcp:,
 * rtmp:, http:, pipe:, concat:) as a protocol and a leading dash as an option; an absolute path starts
 * with the separator, so it is always a plain local file.
 */
export function localPath(p: string): string {
  if (typeof p !== 'string' || p.trim() === '') throw new ScreenrecError('E_BAD_ARGS', 'Empty file path', 'Pass a file path.');
  if (URL_RE.test(p)) {
    throw new ScreenrecError('E_BAD_ARGS', `"${p.split('://')[0]}://..." is a URL, not a file path`,
      'Pass a local file path; screenrec never reads or writes over the network.');
  }
  return path.resolve(p);
}

/** True when both paths exist and are the same file: a symlink, a hard link or a case variant on a case-insensitive volume. */
function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

/** Clean-up commands never overwrite their input (or the input's sidecar), by any name. */
export function assertNotInput(input: string, out: string, opts: { sidecar?: boolean } = {}): void {
  const fix = 'Choose a different --out path, or omit --out to get <name>.<command>.<ext>.';
  if (sameFile(out, input)) {
    throw new ScreenrecError('E_BAD_ARGS', `--out is the same file as the input: ${input}`, fix);
  }
  if (opts.sidecar && sameFile(`${stripExt(out)}.json`, `${stripExt(input)}.json`)) {
    throw new ScreenrecError('E_BAD_ARGS', `--out would overwrite the input's metadata file ${stripExt(input)}.json`, fix);
  }
}

export const FORCE_NEEDS_OUT_FIX = '--force only applies with --out.';

/** --force (MCP force) is meaningless without an explicit --out: refuse it rather than ignore it. */
export function assertForceHasOut(force: boolean | undefined, out: string | undefined): void {
  if (force && out === undefined) throw new ScreenrecError('E_BAD_ARGS', '--force was given without --out', FORCE_NEEDS_OUT_FIX);
}

export const OUT_EXISTS_FIX = 'Choose a different --out path, add --force to replace it, or omit --out to get a new name. ' +
  '(MCP: change out, pass force: true, or omit out.)';

/** True for anything at `p`, including a dangling symlink (writing through it would create its target). */
function taken(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * An explicit output path never silently replaces an existing file: call it only when the user named
 * the path (derived names are already free). `sidecar` also checks the <out>.json the command will
 * write next to it. `force` allows replacing files, never a directory; it does not lift assertNotInput.
 */
export function assertOutFree(out: string, opts: { force?: boolean; sidecar?: boolean } = {}): void {
  for (const f of [out, ...(opts.sidecar ? [`${stripExt(out)}.json`] : [])]) {
    const st = taken(f);
    if (!st) continue;
    if (st.isDirectory()) throw new ScreenrecError('E_BAD_ARGS', `Output is a directory: ${f}`, 'Pass a file path to --out, not a folder.');
    if (!opts.force) throw new ScreenrecError('E_BAD_ARGS', `Output already exists: ${f}`, OUT_EXISTS_FIX);
  }
}

export const OUT_FOLDER_FIX = 'Create the folder first or choose another --out.';

/**
 * The folder `out` goes into must already exist: the temp sibling is written there, and a missing
 * folder would otherwise surface from ffmpeg or the helper as a misleading failure. An explicit --out
 * never creates folders (only the default output folder is created, see recordingsDir).
 */
export function assertOutFolder(out: string): void {
  const dir = path.dirname(path.resolve(out));
  let st: fs.Stats;
  try { st = fs.statSync(dir); }
  catch (e) {
    if (errCode(e) === 'ENOTDIR') throw new ScreenrecError('E_BAD_ARGS', `not a folder: ${firstFileIn(dir)}`, OUT_FOLDER_FIX);
    if (errCode(e) === 'ENOENT') throw new ScreenrecError('E_BAD_ARGS', `folder does not exist: ${dir}`, OUT_FOLDER_FIX);
    const why = { EACCES: 'permission denied', EPERM: 'permission denied', ELOOP: 'symbolic link loop' }[errCode(e) ?? ''];
    if (why) throw new ScreenrecError('E_BAD_ARGS', `cannot use folder: ${dir} (${why})`, OUT_FOLDER_FIX);
    throw e;
  }
  if (!st.isDirectory()) throw new ScreenrecError('E_BAD_ARGS', `not a folder: ${dir}`, OUT_FOLDER_FIX);
  try { fs.accessSync(dir, fs.constants.W_OK); }
  catch { throw new ScreenrecError('E_BAD_ARGS', `folder is not writable: ${dir}`, OUT_FOLDER_FIX); }
}

/** The deepest existing ancestor of `dir` when it is a file (what ENOTDIR is about); else `dir`. */
function firstFileIn(dir: string): string {
  for (let p = dir; ; p = path.dirname(p)) {
    const st = taken(p);
    if (st) return st.isDirectory() ? dir : p;
    if (path.dirname(p) === p) return dir;
  }
}

const isDir = (p: string) => taken(p)?.isDirectory() === true;
const dirError = (p: string) => new ScreenrecError('E_BAD_ARGS', `Output is a directory: ${p}`, 'Pass a file path to --out, not a folder.');

/** A temp sibling of `out` that keeps its extension, so ffmpeg still picks the format from it. */
export function tempSibling(out: string): string {
  const ext = path.extname(out);
  return path.join(path.dirname(out), `.${path.basename(out, ext)}.${crypto.randomBytes(4).toString('hex')}.tmp${ext}`);
}

export interface PublishOps { link(from: string, to: string): void; copy(from: string, to: string): void; rename(from: string, to: string): void }
const realOps: PublishOps = {
  link: (a, b) => fs.linkSync(a, b),
  copy: (a, b) => fs.copyFileSync(a, b),  // onto the empty file tryPublish has just claimed
  rename: (a, b) => fs.renameSync(a, b),
};
const existsError = (p: string) => new ScreenrecError('E_BAD_ARGS', `Output already exists: ${p}`, OUT_EXISTS_FIX);

/**
 * Puts the finished temp file at `out`; false when `out` exists by now (only without force). The temp
 * file stays, so the caller can retry another name or undo. Without force a hard link never replaces,
 * so a file that appeared after the check is safe; with force it is a same-folder rename, so `out` is
 * either the old file or the complete new one.
 */
function tryPublish(tmp: string, out: string, force: boolean | undefined, ops: PublishOps): boolean {
  if (isDir(out)) throw dirError(out);
  if (force) { ops.rename(tmp, out); return true; }
  try { ops.link(tmp, out); return true; }
  catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(errCode(e) ?? '')) throw e;
  }
  // No hard links on this volume (FAT, some network shares): claim the name with O_EXCL, then copy onto it.
  // Only a name this run claimed is ever removed: a copy that failed before writing (an unreadable temp,
  // say) must not delete a file that was already there.
  try { fs.closeSync(fs.openSync(out, 'wx')); }
  catch (c) { if (errCode(c) === 'EEXIST') return false; throw c; }
  try { ops.copy(tmp, out); return true; }
  catch (c) {
    fs.rmSync(out, { force: true });  // ours: never leave a partial file at the real name
    throw c;
  }
}

/** Moves a finished temp file to `out`, refusing a file that exists by now unless force. */
export function publish(tmp: string, out: string, opts: { force?: boolean } = {}, ops: PublishOps = realOps): void {
  if (!tryPublish(tmp, out, opts.force, ops)) throw existsError(out);
  fs.rmSync(tmp, { force: true });
}

// Temp files in flight: removed (and ffmpeg stopped) if the process is interrupted, where finally never runs.
const liveTemps = new Set<string>();
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
function onSignal(sig: NodeJS.Signals): void {
  stopFfmpegChildren();
  for (const t of liveTemps) fs.rmSync(t, { force: true });
  liveTemps.clear();
  for (const s of SIGNALS) process.off(s, onSignal);
  // Nobody else handles it: die of the signal as Node would have by default.
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}
function track(t: string): void {
  if (liveTemps.size === 0) for (const s of SIGNALS) process.on(s, onSignal);
  liveTemps.add(t);
}
function untrack(t: string): void {
  fs.rmSync(t, { force: true });
  if (liveTemps.delete(t) && liveTemps.size === 0) for (const s of SIGNALS) process.off(s, onSignal);
}

/** out, then <out>-2, <out>-3 ... with the extension kept (the derivedOut and recording scheme). */
const nameAt = (out: string, i: number) => (i === 1 ? out : `${stripExt(out)}-${i}${path.extname(out)}`);

export interface Written<T> { value: T; out: string; sidecar?: string }

/**
 * Runs `write` against a temp sibling of `out` and publishes it only if `write` succeeds; then the
 * sidecar from `opts.sidecar`, so a failed video publish never leaves a new sidecar by an old video.
 * An explicit --out (opts.explicit) is refused if it exists by now (unless force); a default name
 * steps to the next free name instead. On any failure the temp files are removed and whatever was at
 * `out` is left exactly as it was. Errors name `out`, never the deleted temp file.
 */
export async function writeOut<T>(out: string, opts: { force?: boolean; explicit?: boolean; sidecar?: (v: T) => Sidecar | undefined },
  write: (tmp: string) => Promise<T>, ops: PublishOps = realOps): Promise<Written<T>> {
  assertOutFolder(out);
  const tmp = tempSibling(out);
  let scTmp: string | undefined;
  track(tmp);
  try {
    let value: T;
    try { value = await write(tmp); }
    catch (e) {
      if (e instanceof Error) e.message = e.message.split(tmp).join(out);
      throw e;
    }
    const data = opts.sidecar?.(value);
    if (data) { scTmp = tempSibling(`${stripExt(out)}.json`); track(scTmp); writeSidecar(scTmp, data); }
    for (let i = 1; i < 10_000; i++) {
      const name = nameAt(out, i);
      const side = data ? `${stripExt(name)}.json` : undefined;
      if (!opts.explicit && (isDir(name) || (side && taken(side)))) continue;  // keep the pair together
      if (!tryPublish(tmp, name, opts.force, ops)) {
        if (opts.explicit) throw existsError(name);
        continue;
      }
      if (side && scTmp && !tryPublish(scTmp, side, opts.force, ops)) {
        fs.rmSync(name, { force: true });  // our own fresh link (force never gets here): undo it
        if (opts.explicit) throw existsError(side);
        continue;
      }
      return { value, out: name, sidecar: side };
    }
    throw existsError(out);
  } finally {
    untrack(tmp);
    if (scTmp) untrack(scTmp);
  }
}
