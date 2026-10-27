import fs from 'node:fs';
import { runFfmpeg, probe } from './ffmpeg.ts';
import { ScreenrecError } from '../core/errors.ts';
import { derivedOut } from '../core/paths.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';

export function frameArgs(input: string, output: string, at: number, width?: number): string[] {
  return ['-v', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', ...(width ? ['-vf', `scale=${width}:-2`] : []), output];
}

export async function frame(input: string, opts: { at: number; width?: number; out?: string; force?: boolean }) {
  if (!Number.isFinite(opts.at) || opts.at < 0) throw new ScreenrecError('E_BAD_ARGS', `--at must be a number of seconds >= 0, got "${String(opts.at)}"`, 'Example: screenrec frame in.mp4 --at 1.5');
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, `frame-${opts.at}s`, 'png'));
  assertNotInput(input, out);
  assertOutFolder(out);
  if (opts.out) assertOutFree(out, { force: opts.force });
  const { duration } = await probe(input);
  const pastEnd = () => new ScreenrecError('E_BAD_ARGS', `--at ${opts.at} is past the end of the video (${duration.toFixed(2)} s)`,
    `Pick a time before the end, e.g. --at ${Math.max(0, Math.floor((duration - 0.1) * 10) / 10)}.`);
  if (opts.at >= duration) throw pastEnd();
  const w = await writeOut(out, { force: opts.force, explicit: opts.out !== undefined }, async (tmp) => {
    await runFfmpeg(frameArgs(input, tmp, opts.at, opts.width));
    // just before the end but after the last frame's timestamp, ffmpeg succeeds and writes nothing
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw pastEnd();
  });
  return { out: w.out };
}
