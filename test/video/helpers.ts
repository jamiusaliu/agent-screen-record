import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Rect } from '../../src/core/geometry.ts';
const exec = promisify(execFile);

export async function makeVideo(file: string, kind: 'moving' | 'moving-frozen-moving', opts: { size?: string; seconds?: number; offset?: number } = {}) {
  const size = opts.size ?? '320x240';
  const src = kind === 'moving'
    // noise gives every region real detail, so blur measurements are stable
    ? `testsrc2=size=${size}:rate=30:duration=${opts.seconds ?? 2},noise=alls=40:allf=t+u`
    // 2 s moving, frame 59 held for 120 frames (4 s), then 2 s moving: 8 s total
    : `testsrc2=size=${size}:rate=30:duration=4,loop=loop=120:size=1:start=59,setpts=N/30/TB`;
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, ...(opts.offset ? ['-output_ts_offset', String(opts.offset)] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', file]);
}

export async function grayRegion(file: string, atSec: number, r: Rect): Promise<Buffer> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1',
    '-vf', `crop=${r.width}:${r.height}:${r.x}:${r.y},format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 });
  return stdout as unknown as Buffer;
}

/** Mean absolute difference between horizontal neighbours: high for detailed images, low for blurred ones. */
export function detail(buf: Buffer, width: number): number {
  let sum = 0, n = 0;
  for (let i = 0; i < buf.length - 1; i++) { if ((i + 1) % width === 0) continue; sum += Math.abs(buf[i] - buf[i + 1]); n++; }
  return sum / n;
}

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length;
}
