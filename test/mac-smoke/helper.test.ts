import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const bin = new URL('../../bin/screenrec-mac', import.meta.url).pathname;
const skip = process.platform !== 'darwin' || !fs.existsSync(bin) ? 'needs macOS and npm run build:native' : false;
const run = (...args: string[]) => JSON.parse(execFileSync(bin, args, { encoding: 'utf8' }).trim().split('\n').at(-1)!);

test('displays lists at least the main display with a scale', { skip }, () => {
  const r = run('displays');
  assert.equal(r.ok, true);
  assert.ok(r.displays.length >= 1);
  const main = r.displays.find((d: { main: boolean }) => d.main);
  assert.ok(main && main.scale >= 1 && main.width > 0);
});

test('permission reports a boolean', { skip }, () => {
  assert.equal(typeof run('permission').granted, 'boolean');
});

test('windows returns layer-0 windows with z order', { skip }, () => {
  const r = run('windows');
  assert.equal(r.ok, true);
  for (const w of r.windows) { assert.equal(typeof w.id, 'number'); assert.equal(typeof w.z, 'number'); assert.ok(w.width >= 50); }
});

import os from 'node:os'; import path from 'node:path';

test('screenshot of the main display writes a PNG of the requested size', { skip }, () => {
  const d = run('displays').displays.find((x: { main: boolean }) => x.main);
  const w = Math.floor((d.width * d.scale) / 4) * 2, h = Math.floor((d.height * d.scale) / 4) * 2; // half size, even
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const out = path.join(dir, 'main.png');
  try {
    const r = run('screenshot', '--display-id', String(d.id), '--size', `${w},${h}`, '--out', out);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(out).subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(r.width, w); assert.equal(r.height, h);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import { spawnSync } from 'node:child_process';

// Each case fails in argument validation, before any ScreenCaptureKit call, so it needs no screen.
const badArgs: [string, string[], RegExp][] = [
  ['odd size', ['--display-id', '1', '--size', '801,500'], /size must be even/],
  ['zero size', ['--display-id', '1', '--size', '0,500'], /size/],
  ['NaN size', ['--display-id', '1', '--size', 'nan,500'], /size/],
  ['huge size', ['--display-id', '1', '--size', '1e400,500'], /size/],
  ['size with junk part', ['--display-id', '1', '--size', '800,abc,500'], /size/],
  ['zero-width region', ['--display-id', '1', '--size', '800,500', '--region', '0,0,0,10'], /region/],
  ['non-numeric region', ['--display-id', '1', '--size', '800,500', '--region', '0,0,x,10'], /region/],
  ['NaN region', ['--display-id', '1', '--size', '800,500', '--region', '0,nan,10,10'], /region/],
  ['region with a window', ['--window-id', '7', '--size', '800,500', '--region', '0,0,10,10'], /region/],
  ['fps zero', ['--display-id', '1', '--size', '800,500', '--fps', '0'], /fps/],
  ['fps too high', ['--display-id', '1', '--size', '800,500', '--fps', '121'], /fps/],
  ['fps not an integer', ['--display-id', '1', '--size', '800,500', '--fps', '29.97'], /fps/],
];

const recordOnly: [string, string[], RegExp][] = [
  ['NaN max-seconds', ['--display-id', '1', '--size', '800,500', '--max-seconds', 'nan'], /max-seconds/],
  ['negative max-seconds', ['--display-id', '1', '--size', '800,500', '--max-seconds', '-1'], /max-seconds/],
];

for (const cmd of ['screenshot', 'record']) {
  for (const [name, flags, msg] of cmd === 'record' ? [...badArgs, ...recordOnly] : badArgs) {
    test(`${cmd} rejects ${name} with E_BAD_ARGS before capturing`, { skip }, () => {
      const r = spawnSync(bin, [cmd, ...flags, '--out', '/nonexistent/x'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(r.status, 1, `exit ${r.status} signal ${r.signal} stdout ${r.stdout}`);
      const j = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
      assert.equal(j.code, 'E_BAD_ARGS');
      assert.match(j.message, msg);
    });
  }
}

test('helper self-test: follow rules, 3-decimal marks, out-of-order frames never fail the writer', { skip }, () => {
  const r = run('selftest');
  const failed = r.cases.filter((c: { pass: boolean }) => !c.pass);
  assert.deepEqual(failed, []);
  assert.ok(r.cases.length >= 17);
});

test('a square region in a wide frame is centred, not left-aligned', { skip }, () => {
  const d = run('displays').displays.find((x: { main: boolean }) => x.main);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  try {
    const out = path.join(dir, 'sq.png'), raw = path.join(dir, 'g.raw');
    const side = Math.min(d.width, d.height) / 2;
    run('screenshot', '--display-id', String(d.id), '--region', `0,0,${side},${side}`, '--size', '1172,400', '--out', out);
    execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
    const g = fs.readFileSync(raw), W = 1172, H = 400;
    const lit = (x: number) => { for (let y = 0; y < H; y += 2) if (g[y * W + x] > 4) return true; return false; };
    let first = 0; while (first < W && !lit(first)) first++;
    let last = W - 1; while (last > 0 && !lit(last)) last--;
    // 400 px of content centred in 1172: columns 386 to 785 (allow 3 px of edge darkness).
    assert.ok(Math.abs(first - 386) <= 3 && Math.abs(last - 785) <= 3, `content columns ${first} to ${last}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
