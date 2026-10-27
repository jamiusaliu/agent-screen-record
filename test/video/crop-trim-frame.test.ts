import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { crop } from '../../src/edit/crop.ts';
import { trim } from '../../src/edit/trim.ts';
import { squeeze } from '../../src/edit/squeeze.ts';
import { frame } from '../../src/edit/frame.ts';
import { probe } from '../../src/edit/ffmpeg.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import { writeSidecar, readSidecar } from '../../src/core/sidecar.ts';

test('crop, trim and frame produce the expected sizes and durations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 8 });
    const c = await crop(input, { rect: { x: 10, y: 10, width: 101, height: 51 } });
    const pc = await probe(c.out); assert.equal(pc.width, 100); assert.equal(pc.height, 50);
    const t = await trim(input, { from: 2, to: 5 });
    assert.ok(t.durationSec > 2.8 && t.durationSec < 3.2, `trim ${t.durationSec}`);
    const f = await frame(input, { at: 1, width: 160 });
    const pf = await probe(f.out); assert.equal(pf.width, 160);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trim shifts marks inside the range by -from, drops the others and updates durationSec', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 8 });
    writeSidecar(path.join(dir, 'in.json'), { version: 1, target: { kind: 'display', display: 'main' }, startedAt: '2026-10-17T00:00:00Z', durationSec: 8,
      marks: [{ t: 1, text: 'before' }, { t: 3.5, text: 'inside' }, { t: 4.25, text: 'inside2' }, { t: 7, text: 'after' }] });
    const r = await trim(input, { from: 2, to: 5 });
    const sc = readSidecar(r.sidecar!)!;
    assert.deepEqual(sc.marks, [{ t: 1.5, text: 'inside' }, { t: 2.25, text: 'inside2' }]);
    assert.equal(sc.durationSec, r.durationSec);
    assert.ok(r.durationSec > 2.8 && r.durationSec < 3.2, `trim ${r.durationSec}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trim and squeeze ignore an unrelated same-named JSON and leave it alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));
  try {
    const input = path.join(dir, 'other.mp4');
    await makeVideo(input, 'moving', { seconds: 3 });
    const foreign = path.join(dir, 'other.json');
    fs.writeFileSync(foreign, '{"title":"x"}');
    const t = await trim(input, { from: 0, to: 2 });
    assert.equal(t.sidecar, undefined);
    const s = await squeeze(input, {});
    assert.equal(s.sidecar, undefined);
    assert.equal(fs.readFileSync(foreign, 'utf8'), '{"title":"x"}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('squeeze copies only sidecar fields, never foreign ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 2 });
    fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify({ version: 1, target: { kind: 'display', display: 'main' }, startedAt: 's', durationSec: 2, marks: [{ t: 1, text: 'a' }], token: 'secret' }));
    const s = await squeeze(input, {});
    const raw = JSON.parse(fs.readFileSync(s.sidecar!, 'utf8'));
    assert.equal(raw.token, undefined);
    assert.equal(raw.marks.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frame at or past the end, and trim starting past the end, are E_BAD_ARGS naming the duration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 2 });
    const badArgs = (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && /past the end/.test(e.message) && /2(\.0+)? s/.test(e.message);
    await assert.rejects(frame(input, { at: 2 }), badArgs);
    await assert.rejects(frame(input, { at: 9 }), badArgs);
    // just inside the duration but after the last frame's timestamp: never an internal error
    await frame(input, { at: 1.99 }).then((r) => assert.ok(fs.statSync(r.out).size > 0), (e: ScreenrecError) => assert.equal(e.code, 'E_BAD_ARGS'));
    await assert.rejects(trim(input, { from: 10, to: 20 }), badArgs);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no temp file left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
