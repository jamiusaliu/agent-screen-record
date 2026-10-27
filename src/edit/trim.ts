import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { derivedOut, stripExt } from '../core/paths.ts';
import { readSidecar } from '../core/sidecar.ts';
import { ScreenrecError } from '../core/errors.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';

export function trimArgs(input: string, output: string, from: number, to: number): string[] {
  return ['-v', 'error', '-y', '-ss', String(from), '-to', String(to), '-i', input, '-an', ...ENCODE, output];
}

export async function trim(input: string, opts: { from: number; to: number; out?: string; force?: boolean }) {
  if (!(opts.to > opts.from && opts.from >= 0)) throw new ScreenrecError('E_BAD_ARGS', `--from ${opts.from} --to ${opts.to} is empty`, 'Use --from < --to, in seconds.');
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, 'trim', 'mp4'));
  assertNotInput(input, out, { sidecar: true });
  assertOutFolder(out);
  const sc = readSidecar(`${stripExt(input)}.json`);
  if (opts.out) assertOutFree(out, { force: opts.force, sidecar: sc !== null });
  const { duration } = await probe(input);
  if (opts.from >= duration) {
    throw new ScreenrecError('E_BAD_ARGS', `--from ${opts.from} is past the end of the video (${duration.toFixed(2)} s)`, 'Use a --from before the end; --to may go past it.');
  }
  // Encode and check a temp file; the real out (and sidecar) only change once that has worked.
  const marks = sc?.marks.filter((m) => m.t >= opts.from && m.t <= opts.to).map((m) => ({ ...m, t: Math.round((m.t - opts.from) * 1000) / 1000 }));
  const w = await writeOut<number>(out, { force: opts.force, explicit: opts.out !== undefined, sidecar: (d) => (sc && marks ? { ...sc, durationSec: d, marks } : undefined) },
    async (tmp) => {
      await runFfmpeg(trimArgs(input, tmp, opts.from, opts.to));
      return (await probe(tmp)).duration;
    });
  return { out: w.out, durationSec: w.value, sidecar: w.sidecar };
}
