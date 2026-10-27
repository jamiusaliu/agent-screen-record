import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squeezeArgs, parseShowinfoPts } from '../../src/edit/squeeze.ts';

test('squeezeArgs builds an argument array, no shell, paths untouched', () => {
  const a = squeezeArgs('/v/My Clip é.mp4', '/v/out file.mp4', 30);
  assert.equal(a[a.indexOf('-i') + 1], '/v/My Clip é.mp4');
  assert.equal(a.at(-1), '/v/out file.mp4');
  assert.ok(a.includes('mpdecimate=hi=768:lo=320:frac=0.5,setpts=N/30/TB'));
  assert.ok(a.includes('yuv420p'));
});

test('parseShowinfoPts reads pts_time values in order', () => {
  const s = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:   6000 pts_time:2.033333 x\n';
  assert.deepEqual(parseShowinfoPts(s), [0, 2.033333]);
});

import { holdCuts, retimeWithCuts, holdFilter, holdArgs } from '../../src/edit/squeeze.ts';
import { parseFfmpegVersion, ffmpegTooOld } from '../../src/edit/ffmpeg.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('holdCuts keeps at most hold seconds of every still stretch, including the tail', () => {
  const cuts = holdCuts([0, 0.5, 3, 3.2], 0.5, 6);
  assert.equal(cuts.length, 2);
  // stretch 0.5..3 (2.5 s) cut after 1.0; tail after 3.2 cut after 3.7; short stretches are untouched
  assert.equal(cuts[0].from, 1);
  assert.ok(Math.abs(cuts[0].to - 3) < 0.001);
  assert.equal(cuts[1].from, 3.7);
  assert.equal(cuts[1].to, Infinity);
  assert.deepEqual(holdCuts([0, 0.4], 0.5, 0.8), []);
  assert.deepEqual(holdCuts([], 0.5, 5), []);
});

test('retimeWithCuts shifts by the removed time; a mark in a cut lands at the end of the preceding kept part', () => {
  const cuts = [{ from: 1, to: 3 }, { from: 3.7, to: Infinity }];
  const r = retimeWithCuts([{ t: 0.4, text: 'a' }, { t: 2, text: 'in cut' }, { t: 3.2, text: 'b' }, { t: 5, text: 'tail' }], cuts);
  assert.deepEqual(r.map((m) => m.t), [0.4, 1, 1.2, 1.7]);
  assert.deepEqual(r.map((m) => m.text), ['a', 'in cut', 'b', 'tail']);
  assert.deepEqual(retimeWithCuts([{ t: 2, text: 'x' }], []), [{ t: 2, text: 'x' }]);
});

test('holdFilter selects outside the cuts and closes the gaps in the timeline', () => {
  const f = holdFilter([{ from: 1, to: 3 }, { from: 3.7, to: Infinity }]);
  assert.equal(f, "select='not(gte(t,1)*lt(t,3)+gte(t,3.7))',setpts='PTS-(gte(T,3)*2)/TB'");
  assert.equal(holdFilter([]), "setpts='PTS'");
});

test('holdArgs passes a short filter inline and a long one from a file, paths untouched', () => {
  const inline = holdArgs('/v/My é.mp4', '/v/o p.mp4', 30, { vf: "setpts='PTS'" });
  assert.equal(inline[inline.indexOf('-i') + 1], '/v/My é.mp4');
  assert.equal(inline.at(-1), '/v/o p.mp4');
  assert.equal(inline[inline.indexOf('-vf') + 1], "setpts='PTS'");
  for (const flag of ['-/filter:v', '-filter_script:v'] as const) {
    const f = holdArgs('in.mp4', 'out.mp4', 30, { file: '/tmp/f.txt', flag });
    assert.equal(f[f.indexOf(flag) + 1], '/tmp/f.txt');
    assert.ok(!f.includes('-vf'));
  }
});

// ffmpeg's parser recurses per paren level AND per chained '+', so count both: that is what hits its limit (about 100).
const depth = (s: string) => {
  const stack: number[] = [0]; let max = 0;
  for (const c of s) {
    if (c === '(') stack.push(1);
    else if (c === ')') stack.pop();
    else if (c === '+') stack[stack.length - 1]++;
    max = Math.max(max, stack.reduce((x, y) => x + y, 0));
  }
  return max;
};

test('the depth metric flags a flat sum', () => {
  assert.ok(depth(`not(${Array.from({ length: 300 }, (_, i) => `gte(t,${i})`).join('+')})`) > 200);
});

test('holdFilter nests as a balanced tree, so 4000 cuts stay shallow for ffmpeg', () => {
  for (const n of [1, 2, 3, 300, 4000]) {
    const cuts = Array.from({ length: n }, (_, i) => ({ from: i * 2 + 1, to: i * 2 + 2 }));
    const f = holdFilter(cuts);
    assert.ok(depth(f) <= 2 * Math.ceil(Math.log2(n + 1)) + 8, `${n} cuts: depth ${depth(f)}`);
    assert.equal(f.split('gte(t,').length - 1, n, 'every cut is selected');
    assert.equal(f.split('gte(T,').length - 1, n, 'every cut closes its gap');
  }
});

test('parseFfmpegVersion reads release, distro and git builds', () => {
  assert.deepEqual(parseFfmpegVersion('ffmpeg version 9.0.2 Copyright (c) 2000-2026'), [9, 0]);
  assert.deepEqual(parseFfmpegVersion('ffmpeg version n6.1.1 Copyright'), [6, 1]);
  assert.deepEqual(parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright'), [6, 1]);
  assert.equal(parseFfmpegVersion('ffmpeg version N-117000-gabcdef Copyright'), null);
  assert.equal(ffmpegTooOld('ffmpeg version 4.4.2 Copyright'), true);
  assert.equal(ffmpegTooOld('ffmpeg version 5.1 Copyright'), false);
  assert.equal(ffmpegTooOld('ffmpeg version N-117000-gabcdef Copyright'), false);
});

test('squeeze rejects a negative or non-finite hold', async () => {
  const { squeeze } = await import('../../src/edit/squeeze.ts');
  for (const hold of [-1, NaN]) {
    await assert.rejects(squeeze('/nonexistent/in.mp4', { hold }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  }
});
