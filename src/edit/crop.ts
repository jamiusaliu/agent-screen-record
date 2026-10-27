import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { even, type Rect } from '../core/geometry.ts';
import { derivedOut } from '../core/paths.ts';
import { ScreenrecError } from '../core/errors.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';

export function parseRect(s: string): Rect {
  const n = s.split(',').map((v) => Number(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new ScreenrecError('E_BAD_ARGS', `Bad rectangle "${s}"`, 'Use x,y,width,height in output pixels, e.g. --rect 0,80,1600,900');
  }
  return { x: n[0], y: n[1], width: n[2], height: n[3] };
}

export function cropRect(frame: { width: number; height: number }, opts: { rect?: Rect; trimEdges?: number }): Rect {
  let r: Rect;
  if (opts.rect) r = opts.rect;
  else if (opts.trimEdges !== undefined) { const t = opts.trimEdges; r = { x: t, y: t, width: frame.width - 2 * t, height: frame.height - 2 * t }; }
  else throw new ScreenrecError('E_BAD_ARGS', 'crop needs --rect or --trim-edges', 'Example: screenrec crop in.mp4 --trim-edges 8');
  const out = { x: Math.round(r.x), y: Math.round(r.y), width: even(r.width), height: even(r.height) };
  if (out.x < 0 || out.y < 0 || out.x + out.width > frame.width || out.y + out.height > frame.height || r.width < 2 || r.height < 2) {
    throw new ScreenrecError('E_BAD_ARGS', `Crop ${out.x},${out.y},${out.width},${out.height} is outside the ${frame.width}x${frame.height} frame`,
      'Measure with "screenrec frame <in> --at <s>" and use output pixels.');
  }
  return out;
}

export function cropArgs(input: string, output: string, r: Rect): string[] {
  return ['-v', 'error', '-y', '-i', input, '-vf', `crop=${r.width}:${r.height}:${r.x}:${r.y}`, '-an', ...ENCODE, output];
}

export async function crop(input: string, opts: { rect?: Rect; trimEdges?: number; out?: string; force?: boolean }) {
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, 'crop', 'mp4'));
  assertNotInput(input, out);
  assertOutFolder(out);
  if (opts.out) assertOutFree(out, { force: opts.force });
  const p = await probe(input);
  const rect = cropRect(p, opts);
  const w = await writeOut(out, { force: opts.force, explicit: opts.out !== undefined }, (tmp) => runFfmpeg(cropArgs(input, tmp, rect)));
  return { out: w.out, rect };
}
