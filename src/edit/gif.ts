import fs from 'node:fs';
import { runFfmpeg, probe } from './ffmpeg.ts';
import { derivedOut } from '../core/paths.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';

export function gifArgs(input: string, output: string, width: number, fps: number): string[] {
  const vf = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
  return ['-v', 'error', '-y', '-i', input, '-vf', vf, '-loop', '0', output];
}

export async function gif(input: string, opts: { width?: number; fps?: number; out?: string; force?: boolean } = {}) {
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, 'gif', 'gif'));
  assertNotInput(input, out);
  assertOutFolder(out);
  if (opts.out) assertOutFree(out, { force: opts.force });
  const src = await probe(input);
  const width = Math.min(opts.width ?? 800, src.width);
  const w = await writeOut(out, { force: opts.force, explicit: opts.out !== undefined }, (tmp) => runFfmpeg(gifArgs(input, tmp, width - (width % 2), opts.fps ?? 12)));
  return { out: w.out, bytes: fs.statSync(w.out).size };
}
