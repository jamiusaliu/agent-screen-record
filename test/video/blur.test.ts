import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo, grayRegion, detail, meanAbsDiff } from './helpers.ts';
import { blur } from '../../src/edit/blur.ts';

const box = { x: 100, y: 80, width: 80, height: 60 };
const outside = { x: 0, y: 0, width: 80, height: 60 };

test('static box: detail gone inside, unchanged outside', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving');
    const { out } = await blur(input, { boxes: [{ x: box.x, y: box.y, w: box.width, h: box.height }] });
    const before = detail(await grayRegion(input, 1, box), box.width);
    const after = detail(await grayRegion(out, 1, box), box.width);
    assert.ok(after < before * 0.25, `inside detail ${before} -> ${after}`);
    const inOut = await grayRegion(input, 1, outside), outOut = await grayRegion(out, 1, outside);
    const diff = meanAbsDiff(inOut, outOut);
    assert.ok(diff < 12, `outside changed by ${diff}`); // re-encode loss only
    assert.ok(detail(outOut, outside.width) > detail(inOut, outside.width) * 0.8, 'outside keeps its detail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keyframed box without from/to follows its path and stays on, held at its last keyframe, to the end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 3 });
    const { out } = await blur(input, { boxes: [{ w: 60, h: 40, keyframes: [{ t: 0, x: 20, y: 100 }, { t: 1.5, x: 220, y: 100 }] }] });
    const left = { x: 20, y: 100, width: 60, height: 40 }, right = { x: 220, y: 100, width: 60, height: 40 };
    const d = async (f: string, t: number, r: typeof left) => detail(await grayRegion(f, t, r), r.width);
    assert.ok(await d(out, 0.05, left) < (await d(input, 0.05, left)) * 0.35, 'blurred at the start position');
    assert.ok(await d(out, 1.45, right) < (await d(input, 1.45, right)) * 0.35, 'blurred at the end position');
    assert.ok(await d(out, 1.45, left) > (await d(input, 1.45, left)) * 0.7, 'start position clear once the box moved');
    assert.ok(await d(out, 2.5, right) < (await d(input, 2.5, right)) * 0.35, 'still on, at the last position, after the last keyframe');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const probeStart = async (f: string) => {
  const { execFile } = await import('node:child_process');
  return new Promise<number>((res, rej) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', f],
    (e, out) => (e ? rej(e) : res(Number(out.trim())))));
};

test('box times are relative to the video start even when the input starts at 2 s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blo-'));
  try {
    const input = path.join(dir, 'offset.mp4');
    await makeVideo(input, 'moving', { seconds: 4, offset: 2 });
    assert.ok(await probeStart(input) >= 1.9, 'fixture really starts late');
    const { out } = await blur(input, { boxes: [{ x: box.x, y: box.y, w: box.width, h: box.height, from: 1, to: 2 }] });
    const d = async (f: string, t: number) => detail(await grayRegion(f, t, box), box.width);
    assert.ok(await d(out, 1.5) < (await d(input, 1.5)) * 0.25, 'blurred at output t=1.5');
    assert.ok(await d(out, 3) > (await d(input, 3)) * 0.7, 'clear after the window');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keyframed box is at the interpolated position halfway between keyframes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 3 });
    const { out } = await blur(input, { boxes: [{ w: 60, h: 40, keyframes: [{ t: 0, x: 20, y: 100 }, { t: 1.5, x: 220, y: 100 }] }] });
    const mid = { x: 120, y: 100, width: 60, height: 40 }, start = { x: 20, y: 100, width: 60, height: 40 };
    const d = async (f: string, r: typeof mid) => detail(await grayRegion(f, 0.75, r), r.width);
    assert.ok(await d(out, mid) < (await d(input, mid)) * 0.4, 'blurred at the midpoint position');
    assert.ok(await d(out, start) > (await d(input, start)) * 0.7, 'start position clear at the midpoint');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keyframed box without from/to is on before its first keyframe, held at the first position', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blf-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 3 });
    const { out } = await blur(input, { boxes: [{ w: 60, h: 40, keyframes: [{ t: 1.5, x: 20, y: 100 }, { t: 2.5, x: 220, y: 100 }] }] });
    const start = { x: 20, y: 100, width: 60, height: 40 };
    assert.ok(detail(await grayRegion(out, 0.2, start), 60) < detail(await grayRegion(input, 0.2, start), 60) * 0.35, 'blurred before the first keyframe');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a box window entirely past the end is refused with E_BAD_ARGS and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 2 });
    await assert.rejects(blur(input, { boxes: [{ x: 40, y: 40, w: 200, h: 60, from: 50, to: 60 }] }),
      (e: { code: string; message: string }) => e.code === 'E_BAD_ARGS' && /Box #1/.test(e.message));
    // after the last frame (1.967 s at 30 fps) but before the 2 s duration
    await assert.rejects(blur(input, { boxes: [{ x: 40, y: 40, w: 200, h: 60, from: 1.98, to: 3 }] }),
      (e: { code: string; message: string }) => e.code === 'E_BAD_ARGS' && /last frame/.test(e.message));
    assert.deepEqual(fs.readdirSync(dir), ['in.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
