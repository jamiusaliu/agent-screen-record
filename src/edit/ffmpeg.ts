import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { ScreenrecError } from '../core/errors.ts';

const exec = promisify(execFile);
export const ffmpegBin = () => process.env.SCREENREC_FFMPEG ?? 'ffmpeg';
export const ffprobeBin = () => process.env.SCREENREC_FFPROBE ?? 'ffprobe';
export const ENCODE = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
export const MPDECIMATE = 'mpdecimate=hi=768:lo=320:frac=0.5';

const noFfmpeg = () => new ScreenrecError('E_NO_FFMPEG', 'ffmpeg was not found',
  'Install it (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set SCREENREC_FFMPEG.');

export async function requireFfmpeg(): Promise<string> {
  try { const { stdout } = await exec(ffmpegBin(), ['-version']); return stdout.split('\n')[0]; }
  catch { throw noFfmpeg(); }
}

/** ffprobe ships with ffmpeg; finishing a recording and every clean-up command need it. */
export async function requireFfprobe(): Promise<string> {
  try { const { stdout } = await exec(ffprobeBin(), ['-version']); return stdout.split('\n')[0]; }
  catch {
    throw new ScreenrecError('E_NO_FFMPEG', 'ffprobe was not found',
      'It ships with ffmpeg: install ffmpeg (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set SCREENREC_FFPROBE.');
  }
}

// Arguments that ffmpeg would open as a protocol rather than a local file. Paths reach here absolute
// (localPath), and options and filter graphs never start with "word:" (single-letter "v:0" and drive
// letters are fine), so any match is a bug or an attempt to reach the network.
const PROTOCOL_ARG = /^[A-Za-z][A-Za-z0-9+.-]+:/;
function refuseProtocols(args: string[]): void {
  const hit = args.find((a) => PROTOCOL_ARG.test(a));
  if (hit !== undefined) {
    throw new ScreenrecError('E_BAD_ARGS', `Refusing to pass "${hit.split(':')[0]}:..." to ffmpeg: only local file paths are allowed`,
      'Pass a local file path; screenrec never reads or writes over the network.');
  }
}

const children = new Set<ChildProcess>();

/** Kills every ffmpeg this process started that is still running (used when the process is interrupted). */
export function stopFfmpegChildren(): void {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  children.clear();
}

export async function runFfmpeg(args: string[]): Promise<string> {
  refuseProtocols(args);
  try {
    const p = exec(ffmpegBin(), ['-hide_banner', ...args], { maxBuffer: 256 * 1024 * 1024 });
    children.add(p.child);
    try { return (await p).stderr; } finally { children.delete(p.child); }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw noFfmpeg();
    const tail = String(err.stderr ?? err.message).trim().split('\n').slice(-15).join('\n');
    throw new ScreenrecError('E_FFMPEG_FAILED', `ffmpeg failed:\n${tail}`, 'Check the input file plays; re-run with SCREENREC_DEBUG=1 for the full command.');
  }
}

export interface Probe { duration: number; width: number; height: number; fps: number }

export async function probe(file: string): Promise<Probe> {
  refuseProtocols([file]);
  try {
    const { stdout } = await exec(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', file]);
    const j = JSON.parse(stdout) as { streams: { width: number; height: number; avg_frame_rate: string }[]; format: { duration: string } };
    const [n, d] = j.streams[0].avg_frame_rate.split('/').map(Number);
    return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration), fps: d ? n / d : n };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw noFfmpeg();
    throw new ScreenrecError('E_FFMPEG_FAILED', `Could not read video info from ${file}`, 'Is it a finished, playable video file?');
  }
}

/** Oldest ffmpeg squeeze/blur/gif are written for: `-fps_mode` arrived in 5.1. Only 9.0.2 is tested in CI here. */
export const MIN_FFMPEG: [number, number] = [5, 1];

/** [major, minor] from the first line of `ffmpeg -version`; null for git builds ("N-12345-g...") we cannot judge. */
export function parseFfmpegVersion(line: string): [number, number] | null {
  const m = /version\s+n?(\d+)\.(\d+)/i.exec(line);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function ffmpegTooOld(line: string): boolean {
  const v = parseFfmpegVersion(line);
  return v !== null && (v[0] < MIN_FFMPEG[0] || (v[0] === MIN_FFMPEG[0] && v[1] < MIN_FFMPEG[1]));
}

let fileFlag: Promise<'-/filter:v' | '-filter_script:v'> | undefined;
/** Which option reads a filter graph from a file: `-/filter:v` on ffmpeg 7+, `-filter_script:v` before (removed in 9). */
export function filterFileFlag(): Promise<'-/filter:v' | '-filter_script:v'> {
  fileFlag ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffflag-'));
    try {
      const f = path.join(dir, 'f.txt');
      fs.writeFileSync(f, 'null');
      await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-/filter:v', f, '-f', 'null', '-']);
      return '-/filter:v' as const;
    } catch { return '-filter_script:v' as const; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  })();
  return fileFlag;
}
