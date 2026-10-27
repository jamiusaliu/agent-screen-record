import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { parseBoxFlag, lerpExpr, blurGraph, validateBoxes, loadBoxes } from '../../src/edit/blur.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('parseBoxFlag with and without a time window', () => {
  assert.deepEqual(parseBoxFlag('10,20,300,40'), { x: 10, y: 20, w: 300, h: 40 });
  assert.deepEqual(parseBoxFlag('10,20,300,40@2.0-5.5'), { x: 10, y: 20, w: 300, h: 40, from: 2, to: 5.5 });
  assert.throws(() => parseBoxFlag('10,20,300'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('lerpExpr: constant for one keyframe, clamped piecewise-linear for several', () => {
  assert.equal(lerpExpr([{ t: 1, x: 40, y: 600 }], 'x'), '40');
  const e = lerpExpr([{ t: 2, x: 40, y: 600 }, { t: 4.5, x: 40, y: 120 }], 'y');
  assert.equal(e, 'if(lt(t,2),600,if(lt(t,4.5),600+(-480)*(t-2)/2.5,120))');
});

test('blurGraph chains one pixelate+blur+overlay per box; a keyframed box without from/to has no time window', () => {
  const g = blurGraph([{ x: 10, y: 20, w: 120, h: 40 }, { w: 60, h: 40, keyframes: [{ t: 0, x: 20, y: 100 }, { t: 1.5, x: 220, y: 100 }] }]);
  assert.equal(g.out, 'v1');
  assert.match(g.graph, /^\[0:v\]setpts=PTS-STARTPTS,split=3\[base\]\[s0\]\[s1\];/);
  assert.match(g.graph, /\[s0\]crop=w=120:h=40:x='max\(0,min\(iw-120,10\)\)'/);
  assert.match(g.graph, /flags=neighbor,scale=120:40:flags=neighbor,boxblur=/);
  assert.match(g.graph, /overlay=x='[^']+':y='[^']+'\[v1\]$/);
});

test('validateBoxes rejects tiny or out-of-frame boxes and unsorted keyframes', () => {
  const f = { width: 320, height: 240 };
  assert.throws(() => validateBoxes([{ x: 0, y: 0, w: 4, h: 4 }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => validateBoxes([{ x: 300, y: 0, w: 40, h: 40 }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => validateBoxes([{ w: 40, h: 40, keyframes: [{ t: 2, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }] }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  validateBoxes([{ x: 0, y: 0, w: 40, h: 40 }], f);
});

test('validateBoxes rejects boxes from JSON with missing or non-numeric size', () => {
  const f = { width: 320, height: 240 };
  assert.throws(() => validateBoxes([{ x: 0, y: 0 } as never], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => validateBoxes([{ x: 0, y: 0, w: '40', h: 40 } as never], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('lerpExpr with three keyframes nests the segments in order', () => {
  const e = lerpExpr([{ t: 0, x: 0, y: 5 }, { t: 1, x: 100, y: 5 }, { t: 3, x: 100, y: 5 }], 'x');
  assert.equal(e, 'if(lt(t,0),0,if(lt(t,1),0+(100)*(t-0)/1,if(lt(t,3),100+(0)*(t-1)/2,100)))');
});

const F = { width: 320, height: 240 };
const rejects = (boxes: unknown[], index = 1) => assert.throws(() => validateBoxes(boxes as never, F),
  (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.fix.includes(`box #${index}`));

test('validateBoxes rejects every malformed box with E_BAD_ARGS naming the box', () => {
  rejects([{ w: 40, h: 40 }]);                                   // no x,y
  rejects([{ x: NaN, y: 0, w: 40, h: 40 }]);
  rejects([{ x: '5', y: 0, w: 40, h: 40 }]);
  rejects([{ x: 0, y: Infinity, w: 40, h: 40 }]);
  rejects([{ x: 0, y: 0, w: 40.5, h: 40 }]);
  rejects([{ x: 0, y: 0, w: 40, h: 40 }, { x: 0, y: 0, w: 40, h: 40, from: 1 }], 2);   // from without to
  rejects([{ x: 0, y: 0, w: 40, h: 40, to: 1 }]);
  rejects([{ x: 0, y: 0, w: 40, h: 40, from: 2, to: 2 }]);
  rejects([{ x: 0, y: 0, w: 40, h: 40, from: -1, to: 2 }]);
  rejects([{ x: 0, y: 0, w: 40, h: 40, from: NaN, to: 2 }]);
  rejects([{ w: 40, h: 40, keyframes: [] }]);
  rejects([{ w: 40, h: 40, keyframes: [{ t: NaN, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }] }]);
  rejects([{ w: 40, h: 40, keyframes: [{ t: 0, x: 0 }] }]);
  rejects([null]);
  rejects([[1, 2]]);
});

test('parseBoxFlag rejects malformed times such as 1.2.3', () => {
  assert.throws(() => parseBoxFlag('10,20,30,40@1.2.3-4'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseBoxFlag('10,20,30,40@.-.'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('loadBoxes rejects non-object elements with E_BAD_ARGS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
  try {
    const f = path.join(dir, 'b.json');
    fs.writeFileSync(f, '[null]');
    assert.throws(() => loadBoxes(f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.fix.includes('box #1'));
    fs.writeFileSync(f, '[{"x":0,"y":0,"w":8,"h":8}, 3]');
    assert.throws(() => loadBoxes(f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.fix.includes('box #2'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateBoxes refuses a box whose time window starts at or after the end of the video, naming the box', () => {
  const f = { width: 320, height: 240, duration: 6 };
  const ok = { x: 0, y: 0, w: 40, h: 40 };
  for (const bad of [{ ...ok, from: 50, to: 60 }, { ...ok, from: 6, to: 7 }]) {
    assert.throws(() => validateBoxes([ok, bad], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS'
      && /Box #2/.test(e.message) && /6(\.0)? ?s/.test(e.message) && e.fix.includes('box #2'));
  }
  validateBoxes([{ ...ok, from: 5, to: 60 }], f); // overlaps the last second: fine
});

test('a keyframed box without from/to is on for the whole video, held at its first and last keyframe', () => {
  const g = blurGraph([{ w: 60, h: 40, keyframes: [{ t: 1, x: 20, y: 100 }, { t: 2, x: 220, y: 100 }] }]);
  assert.doesNotMatch(g.graph, /enable=/);
  const w = blurGraph([{ w: 60, h: 40, from: 0.5, to: 3, keyframes: [{ t: 1, x: 20, y: 100 }, { t: 2, x: 220, y: 100 }] }]);
  assert.match(w.graph, /enable='between\(t,0.5,3\)'/);
});

test('loadBoxes never quotes the file content back in its error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
  try {
    const f = path.join(dir, 'id_rsa');
    fs.writeFileSync(f, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n');
    assert.throws(() => loadBoxes(f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS'
      && !/BEGIN|OPENSSH|b3Bl/.test(e.message + e.fix) && /not valid JSON/.test(e.message));
    fs.writeFileSync(f, '{"secret":"hunter2"}');
    assert.throws(() => loadBoxes(f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && !/hunter2/.test(e.message + e.fix));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a window starting after the last frame (inside the stated duration) is refused, not a silent no-op', () => {
  const f = { width: 320, height: 240, duration: 6, fps: 30 };  // last frame at about 5.967 s
  const ok = { x: 0, y: 0, w: 40, h: 40 };
  assert.throws(() => validateBoxes([{ ...ok, from: 5.98, to: 7 }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS'
    && /Box #1/.test(e.message) && /last frame/.test(e.message));
  // the last 0.1 s is refused even when the stated frame rate is high (variable frame rate gaps)
  assert.throws(() => validateBoxes([{ ...ok, from: 5.95, to: 7 }], { ...f, fps: 120 }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  validateBoxes([{ ...ok, from: 5.8, to: 7 }], f);
  validateBoxes([{ ...ok, from: 5.8, to: 7 }], { ...f, fps: NaN }); // unknown rate: the 0.1 s margin still applies
});
