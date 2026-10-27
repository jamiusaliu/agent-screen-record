import fs from 'node:fs';
import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { derivedOut } from '../core/paths.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';
import { ScreenrecError } from '../core/errors.ts';

export interface Keyframe { t: number; x: number; y: number }
export interface BlurBox { w: number; h: number; x?: number; y?: number; from?: number; to?: number; keyframes?: Keyframe[] }

const FIX = 'Boxes are x,y,w,h in output pixels (optionally @from-to seconds), at least 8x8, inside the frame. Measure with "screenrec frame".';
const bad = (m: string, index?: number) => new ScreenrecError('E_BAD_ARGS', m,
  index === undefined ? FIX : `Fix box #${index + 1} (counting from 1). ${FIX}`);

export function parseBoxFlag(s: string): BlurBox {
  const m = /^(\d+),(\d+),(\d+),(\d+)(?:@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?))?$/.exec(s.trim());
  if (!m) throw bad(`Bad --box "${s}"`);
  const b: BlurBox = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  if (m[5] !== undefined) { b.from = +m[5]; b.to = +m[6]; }
  return b;
}

// Error text never includes the file's content: an MCP agent may point this at a file it cannot read itself.
export function loadBoxes(file: string): BlurBox[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw bad(`Could not read boxes from ${file}: ${(e as NodeJS.ErrnoException).code ?? 'read error'}`);
  }
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw bad(`Boxes file ${file} is not valid JSON`); }
  if (!Array.isArray(j)) throw bad(`Boxes file ${file} must hold a JSON array of boxes`);
  j.forEach((b, i) => { if (typeof b !== 'object' || b === null || Array.isArray(b)) throw bad(`Box #${i + 1} in ${file} is not an object`, i); });
  return j as BlurBox[];
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Seconds at the end of a video where a box may not start. The container duration runs one frame past
 * the last frame's timestamp, so a window that starts there enables no frame at all. One frame interval
 * covers constant frame rates; the 0.1 s floor covers variable frame rate input (Chrome screencasts),
 * whose average rate understates the gap before the last frame. Refusing a box that would cover at most
 * the last 0.1 s costs nothing; accepting one that covers nothing would report a blur that never happened.
 */
export function endMargin(fps: number | undefined): number {
  return Math.max(finite(fps) && fps > 0 ? 1 / fps : 0, 0.1);
}

export function validateBoxes(boxes: BlurBox[], frame: { width: number; height: number; duration?: number; fps?: number }): void {
  if (boxes.length === 0) throw bad('No boxes given');
  boxes.forEach((b, i) => {
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw bad(`Box #${i + 1} is not an object`, i);
    if (!Number.isInteger(b.w) || !Number.isInteger(b.h) || b.w < 8 || b.h < 8) throw bad(`Box #${i + 1} needs integer w and h of at least 8 (got ${String(b.w)}x${String(b.h)})`, i);
    if ((b.from === undefined) !== (b.to === undefined)) throw bad(`Box #${i + 1} has only one of from/to`, i);
    if (b.from !== undefined && !(finite(b.from) && finite(b.to) && b.from >= 0 && b.from < b.to)) throw bad(`Box #${i + 1} needs finite times with 0 <= from < to`, i);
    // A window that starts at or after the end would blur nothing while the command reports success.
    if (b.from !== undefined && finite(frame.duration) && b.from >= frame.duration) {
      throw bad(`Box #${i + 1} starts at ${num(b.from)} s, at or after the end of the ${num(frame.duration)} s video, so it would blur nothing`, i);
    }
    if (b.from !== undefined && finite(frame.duration) && b.from > frame.duration - endMargin(frame.fps)) {
      throw bad(`Box #${i + 1} starts at ${num(b.from)} s, in the last ${num(endMargin(frame.fps))} s of the ${num(frame.duration)} s video, where it can miss the last frame and blur nothing; start it earlier`, i);
    }
    let points: Keyframe[];
    if (b.keyframes !== undefined) {
      if (!Array.isArray(b.keyframes) || b.keyframes.length === 0) throw bad(`Box #${i + 1} has an empty or invalid keyframes list`, i);
      points = b.keyframes;
    } else points = [{ t: 0, x: b.x as number, y: b.y as number }];
    points.forEach((p, k) => {
      if (typeof p !== 'object' || p === null || !finite(p.x) || !finite(p.y) || (b.keyframes !== undefined && !finite(p.t))) {
        throw bad(`Box #${i + 1} has a missing or non-numeric x, y or t${b.keyframes ? ` in keyframe ${k + 1}` : ''}`, i);
      }
      if (p.x < 0 || p.y < 0 || p.x + b.w > frame.width || p.y + b.h > frame.height) throw bad(`Box #${i + 1} at ${p.x},${p.y} size ${b.w}x${b.h} leaves the ${frame.width}x${frame.height} frame`, i);
      if (k > 0 && !(p.t > points[k - 1].t)) throw bad(`Box #${i + 1} keyframe times must increase`, i);
    });
  });
}


export function lerpExpr(kfs: Keyframe[], axis: 'x' | 'y'): string {
  if (kfs.length === 1) return num(kfs[0][axis]);
  let acc = num(kfs[kfs.length - 1][axis]);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    acc = `if(lt(t,${num(b.t)}),${num(a[axis])}+(${num(b[axis] - a[axis])})*(t-${num(a.t)})/${num(b.t - a.t)},${acc})`;
  }
  return `if(lt(t,${num(kfs[0].t)}),${num(kfs[0][axis])},${acc})`;
}

export function blurGraph(boxes: BlurBox[]): { graph: string; out: string } {
  const parts = [`[0:v]setpts=PTS-STARTPTS,split=${boxes.length + 1}[base]${boxes.map((_, i) => `[s${i}]`).join('')}`];
  let cur = 'base';
  boxes.forEach((b, i) => {
    const X = b.keyframes ? lerpExpr(b.keyframes, 'x') : num(b.x!);
    const Y = b.keyframes ? lerpExpr(b.keyframes, 'y') : num(b.y!);
    const sw = Math.max(1, Math.round(b.w / 12)), sh = Math.max(1, Math.round(b.h / 12));
    const r = Math.max(1, Math.min(10, Math.floor(Math.min(b.w, b.h) / 4) - 1));
    parts.push(`[s${i}]crop=w=${b.w}:h=${b.h}:x='max(0,min(iw-${b.w},${X}))':y='max(0,min(ih-${b.h},${Y}))',` +
      `scale=${sw}:${sh}:flags=neighbor,scale=${b.w}:${b.h}:flags=neighbor,boxblur=${r}:1[b${i}]`);
    // Only an explicit from/to limits a box in time. A keyframed box without one stays on for the whole
    // video, held at its first keyframe before it and at its last after it (lerpExpr clamps): blurring
    // too much is safer than leaving a secret readable before the first or after the last keyframe.
    const enable = b.from !== undefined && b.to !== undefined ? `:enable='between(t,${num(b.from)},${num(b.to)})'` : '';
    parts.push(`[${cur}][b${i}]overlay=x='max(0,min(main_w-${b.w},${X}))':y='max(0,min(main_h-${b.h},${Y}))'${enable}[v${i}]`);
    cur = `v${i}`;
  });
  return { graph: parts.join(';'), out: cur };
}

export async function blur(input: string, opts: { boxes: BlurBox[]; out?: string; force?: boolean }) {
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, 'blur', 'mp4'));
  assertNotInput(input, out);
  assertOutFolder(out);
  if (opts.out) assertOutFree(out, { force: opts.force });
  validateBoxes(opts.boxes, await probe(input));
  const { graph, out: label } = blurGraph(opts.boxes);
  const w = await writeOut(out, { force: opts.force, explicit: opts.out !== undefined }, (tmp) => runFfmpeg(['-v', 'error', '-y', '-i', input, '-filter_complex', graph, '-map', `[${label}]`, '-an', ...ENCODE, tmp]));
  return { out: w.out, boxes: opts.boxes.length };
}
