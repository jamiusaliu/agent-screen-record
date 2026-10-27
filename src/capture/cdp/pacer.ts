import { even } from '../../core/geometry.ts';

export const NO_FRAMES_EXIT = 5;
export const ENCODER_FAILED_EXIT = 6;

export function framesDue(startMs: number, nowMs: number, fps: number, written: number): number {
  return Math.max(0, Math.floor(((nowMs - startMs) * fps) / 1000) - written);
}

export class FrameHolder {
  private frame: Buffer | null = null;
  private count = 0;
  set(jpeg: Buffer): void { this.frame = jpeg; this.count++; }
  get(): Buffer | null { return this.frame; }
  get received(): number { return this.count; }
}

export function outputSize(cssWidth: number, cssHeight: number, dpr: number) {
  return { width: even(cssWidth * dpr), height: even(cssHeight * dpr) };
}

export function encoderArgs(out: string, fps: number, size: { width: number; height: number }): string[] {
  const { width: w, height: h } = size;
  return ['-hide_banner', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-y', out];
}
