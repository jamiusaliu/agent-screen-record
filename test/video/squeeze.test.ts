import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { makeVideo, grayRegion } from './helpers.ts';
const exec = promisify(execFile);
import { squeeze } from '../../src/edit/squeeze.ts';
import { writeSidecar, readSidecar } from '../../src/core/sidecar.ts';

test('squeeze removes a 4 s frozen stretch and retimes marks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  try {
    const input = path.join(dir, 'clip with space.mp4');
    await makeVideo(input, 'moving-frozen-moving');
    writeSidecar(path.join(dir, 'clip with space.json'), { version: 1, target: { kind: 'display', display: 'main' },
      startedAt: '2026-10-17T00:00:00Z', durationSec: 8, marks: [{ t: 7, text: 'late step' }] });
    const r = await squeeze(input);
    assert.ok(r.beforeSec > 7.8 && r.beforeSec < 8.2, `before ${r.beforeSec}`);
    assert.ok(r.afterSec > 3.5 && r.afterSec < 5.0, `after ${r.afterSec}`);
    const sc = readSidecar(r.sidecar!)!;
    assert.ok(sc.marks[0].t > 2.5 && sc.marks[0].t < 4.0, `mark ${sc.marks[0].t}`);
    assert.ok(fs.existsSync(input), 'input untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const sidecarFor = (dir: string, name: string, marks: { t: number; text: string }[], durationSec: number) =>
  writeSidecar(path.join(dir, `${name}.json`), { version: 1, target: { kind: 'display', display: 'main' }, startedAt: '2026-10-17T00:00:00Z', durationSec, marks });

test('hold 0.5 (default) keeps half a second of a 4 s frozen stretch; marks follow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-'));
  try {
    const input = path.join(dir, 'clip.mp4');
    await makeVideo(input, 'moving-frozen-moving');
    sidecarFor(dir, 'clip', [{ t: 1, text: 'early' }, { t: 4, text: 'in the freeze' }, { t: 7, text: 'late' }], 8);
    const r = await squeeze(input, { hold: 0.5 });
    // original 8 s minus about 3.5 s of cut stillness
    assert.ok(r.afterSec > 4.0 && r.afterSec < 5.0, `after ${r.afterSec}`);
    const marks = readSidecar(r.sidecar!)!.marks;
    assert.ok(Math.abs(marks[0].t - 1) < 0.05, `early ${marks[0].t}`);
    assert.ok(marks[1].t > 2.0 && marks[1].t < 3.0, `in-freeze mark ${marks[1].t}`);
    assert.ok(marks[2].t > 3.2 && marks[2].t < 4.0, `late ${marks[2].t}`);
    assert.ok(marks[1].t <= marks[2].t);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hold 0 reproduces the old one-frame behaviour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq0-'));
  try {
    const input = path.join(dir, 'clip.mp4');
    await makeVideo(input, 'moving-frozen-moving');
    const r = await squeeze(input, { hold: 0 });
    assert.ok(r.afterSec > 3.5 && r.afterSec < 5.0, `after ${r.afterSec}`);
    const held = await squeeze(input, { hold: 0.5, out: path.join(dir, 'held.mp4') });
    assert.ok(held.afterSec > r.afterSec + 0.3, `hold keeps more: ${held.afterSec} vs ${r.afterSec}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a still screen followed by a change stays visible for the hold, not one frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqs-'));
  try {
    const input = path.join(dir, 'still.mp4');
    // 3 s of black, then 1 s of moving test pattern
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', input]);
    const whole = { x: 0, y: 0, width: 320, height: 240 };
    const mean = (b: Buffer) => b.reduce((s, v) => s + v, 0) / b.length;
    const held = await squeeze(input, { hold: 0.5, out: path.join(dir, 'h.mp4') });
    assert.ok(held.afterSec > 1.3 && held.afterSec < 1.8, `held ${held.afterSec}`);
    assert.ok(mean(await grayRegion(held.out, 0.1, whole)) < 20, 'black at 0.1 s');
    assert.ok(mean(await grayRegion(held.out, 0.4, whole)) < 20, 'still black at 0.4 s, the hold is visible');
    assert.ok(mean(await grayRegion(held.out, 0.9, whole)) > 40, 'the change follows after the hold');
    const flash = await squeeze(input, { hold: 0, out: path.join(dir, 'f.mp4') });
    assert.ok(flash.afterSec < 1.3, `hold 0 flashes: ${flash.afterSec}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function manyStills(file: string) {
  // 160 pictures, each held 1.2 s: 160 still stretches longer than the 0.5 s hold (192 s at 10 fps, tiny frames)
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=192,noise=alls=30:allf=t+u',
    '-vf', 'fps=1/1.2,fps=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', file]);
}

test('a clip with 160 cuts squeezes (the expression stays shallow), inline and via a filter file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqm-'));
  try {
    const input = path.join(dir, 'many.mp4');
    await manyStills(input);
    const inline = await squeeze(input, { hold: 0.5, out: path.join(dir, 'inline.mp4') });
    assert.ok(inline.beforeSec > 190 && inline.beforeSec < 194, `before ${inline.beforeSec}`);
    assert.ok(inline.afterSec > 70 && inline.afterSec < 90, `inline ${inline.afterSec}`);
    const viaFile = await squeeze(input, { hold: 0.5, out: path.join(dir, 'file.mp4'), inlineLimit: 0 });
    assert.ok(Math.abs(viaFile.afterSec - inline.afterSec) < 0.2, `file ${viaFile.afterSec} vs inline ${inline.afterSec}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
