import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDisplays, listWindows, permission, resolveCaptureSpec, captureArgs, recordArgs, ancestorPids, spawnRecord, helperJson,
  HELPER_MISSING_FIX, HELPER_FIXES, HELPER_EXIT, recordExitError, assertMac, type RecordOptions } from '../../src/capture/mac.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import type { Display } from '../../src/core/geometry.ts';
import type { WindowInfo } from '../../src/core/targets.ts';

const fake = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
const saved = { helper: process.env.SCREENREC_MAC_HELPER, mode: process.env.FAKE_HELPER_MODE };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => { process.env.SCREENREC_MAC_HELPER = fake; delete process.env.FAKE_HELPER_MODE; });
afterEach(() => { restore('SCREENREC_MAC_HELPER', saved.helper); restore('FAKE_HELPER_MODE', saved.mode); });

const displays: Display[] = JSON.parse(fs.readFileSync(new URL('../fixtures/two-displays.json', import.meta.url), 'utf8'));
const win = (id: number, app: string, title: string, x: number, width = 801, height = 501): WindowInfo =>
  ({ id, app, title, x, y: 100, width, height, onScreen: true, z: id, pid: 1 });
const windows = [win(1, 'Finder', 'Downloads', 100), win(2, 'Google Chrome', 'Agent', -1500)];

test('listing goes through the helper JSON protocol', async () => {
  assert.equal((await listDisplays())[0].scale, 2);
  assert.equal((await listWindows())[0].title, 'Downloads');
  assert.equal(await permission(), true);
});

test('helper errors become ScreenrecError with a fix', async () => {
  process.env.FAKE_HELPER_MODE = 'no-permission';
  await assert.rejects(listDisplays(), (e: ScreenrecError) => e.code === 'E_PERMISSION' && /Screen Recording/.test(e.fix));
});

test('a fix sent by the helper wins over the default fix', async () => {
  process.env.FAKE_HELPER_MODE = 'locked';
  await assert.rejects(listWindows(), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && /locked/.test(e.message) && e.fix.startsWith('Unlock the Mac and try again. ') && e.fix !== HELPER_FIXES.E_TARGET_NOT_FOUND);
});

test('window on the 2x display records at 2x, window on the 1x display at 1x, sizes even', () => {
  const a = resolveCaptureSpec({ kind: 'window', app: 'Finder', followApp: false, ignoreApps: [] }, displays, windows, false);
  assert.deepEqual(a.spec, { windowId: 1, sizePx: { width: 1602, height: 1002 }, cursor: false });
  const b = resolveCaptureSpec({ kind: 'window', app: 'Google Chrome', followApp: false, ignoreApps: [] }, displays, windows, true);
  assert.deepEqual(b.spec, { windowId: 2, sizePx: { width: 800, height: 500 }, cursor: true });
});

test('display, display-of and region specs', () => {
  assert.deepEqual(resolveCaptureSpec({ kind: 'display', display: '2' }, displays, windows, false).spec,
    { displayId: 2, sizePx: { width: 1920, height: 1080 }, cursor: false });
  assert.equal(resolveCaptureSpec({ kind: 'display-of', window: 'Google Chrome' }, displays, windows, false).spec.displayId, 2);
  assert.deepEqual(resolveCaptureSpec({ kind: 'region', region: { x: 10, y: 10, width: 301, height: 201 }, display: 'main' }, displays, windows, false).spec,
    { displayId: 1, regionPt: { x: 10, y: 10, width: 301, height: 201 }, sizePx: { width: 602, height: 402 }, cursor: false });
  assert.throws(() => resolveCaptureSpec({ kind: 'tab', mode: 'newest' }, displays, windows, false), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('captureArgs and recordArgs', () => {
  assert.deepEqual(captureArgs({ windowId: 7, sizePx: { width: 800, height: 500 }, cursor: true }), ['--window-id', '7', '--size', '800,500', '--cursor']);
  const r = recordArgs({ displayId: 1, regionPt: { x: 1, y: 2, width: 3, height: 4 }, sizePx: { width: 6, height: 8 }, cursor: false },
    { out: '/tmp/a b.mov', fps: 30, maxSeconds: 600, followApp: true, ignoreApps: ['Orca'], ignorePids: [10, 11], marksFile: '/tmp/m.jsonl', t0Ms: 5, logFile: '/tmp/l' });
  assert.deepEqual(r, ['record', '--display-id', '1', '--region', '1,2,3,4', '--size', '6,8', '--fps', '30', '--out', '/tmp/a b.mov',
    '--max-seconds', '600', '--marks', '/tmp/m.jsonl', '--t0-ms', '5', '--follow-app', '--ignore-app', 'Orca', '--ignore-pid', '10', '--ignore-pid', '11']);
});

test('ancestorPids walks parents and stops at pid 1', () => {
  const parents: Record<number, number> = { 50: 40, 40: 30, 30: 1 };
  assert.deepEqual(ancestorPids(50, (p) => parents[p] ?? null), [40, 30]);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mac-unit-'));
const opts = (dir: string): RecordOptions => ({ out: path.join(dir, 'a.mov'), fps: 30, maxSeconds: 1, followApp: false, ignoreApps: [],
  ignorePids: [], marksFile: path.join(dir, 'm.jsonl'), t0Ms: 1, logFile: path.join(dir, 'log') });
const spec = { displayId: 1, sizePx: { width: 2, height: 2 }, cursor: false };

test('spawnRecord returns a pid and the log file receives the helper output', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.FAKE_HELPER_MODE = 'record-locked';  // prints one line and exits, so nothing keeps running
  const pid = spawnRecord(spec, opts(dir));
  assert.ok(Number.isInteger(pid) && pid > 0);
  const log = path.join(dir, 'log');
  for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('\n')); i++) await new Promise((r) => setTimeout(r, 30));
  assert.match(fs.readFileSync(log, 'utf8'), /No displays are available/);
});

test('spawnRecord with a missing helper throws E_HELPER_CRASHED and does not crash the process', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.SCREENREC_MAC_HELPER = path.join(dir, 'no-such-helper');
  assert.throws(() => spawnRecord(spec, opts(dir)), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && e.fix === HELPER_MISSING_FIX);
  await new Promise((r) => setTimeout(r, 100));  // an unhandled 'error' event would surface here and fail the run
});

test('spawnRecord with a non-executable helper throws E_HELPER_CRASHED', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'helper'); fs.writeFileSync(bad, '#!/bin/sh\n', { mode: 0o644 });
  process.env.SCREENREC_MAC_HELPER = bad;
  assert.throws(() => spawnRecord(spec, opts(dir)), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && e.fix === HELPER_MISSING_FIX);
  await new Promise((r) => setTimeout(r, 100));
});

test('helperJson times out a helper that never answers', async () => {
  process.env.FAKE_HELPER_MODE = 'hang';
  await assert.rejects(helperJson(['displays'], 300), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && /did not answer within/.test(e.message));
});

test('helperJson names the OS error when the helper cannot run', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'helper'); fs.writeFileSync(bad, '#!/bin/sh\n', { mode: 0o644 });
  process.env.SCREENREC_MAC_HELPER = bad;
  await assert.rejects(listDisplays(), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && /EACCES/.test(e.message));
});


test('record exit codes map to errors: 6 is a writer failure with an output-folder fix, 5 is no frames', () => {
  assert.equal(recordExitError(0), null);
  const w = recordExitError(HELPER_EXIT.writerFailed)!;
  assert.equal(w.code, 'E_HELPER_CRASHED'); assert.match(w.fix, /output folder/);
  assert.equal(recordExitError(HELPER_EXIT.noFrames)!.code, 'E_NO_FRAMES');
  assert.equal(recordExitError(1)!.code, 'E_HELPER_CRASHED');
});

test('the helper-missing fix names the npm package, not the unrelated "screenrec" package', () => {
  assert.match(HELPER_MISSING_FIX, /reinstall agent-screen-record/);
  assert.doesNotMatch(HELPER_MISSING_FIX, /install screenrec/);
});

test('screenNoFrames: names a locked screen or sleeping displays, and nothing else', async () => {
  const { screenNoFrames } = await import('../../src/recorder.ts');
  const locked = screenNoFrames('locked');
  assert.equal(locked?.message, 'The recording captured no frames: the screen was locked');
  assert.match(locked!.fix, /^Unlock the Mac and record again\. .*caffeinate -d/);
  assert.equal(screenNoFrames('asleep')?.message, 'The recording captured no frames: the displays were asleep');
  assert.equal(screenNoFrames('off-console')?.message, 'The recording captured no frames: another user session was using the screen');
  assert.match(screenNoFrames('off-console')!.fix, /^Switch back to this user's session/);
  for (const v of [undefined, null, 'awake', 1, 'LOCKED']) assert.equal(screenNoFrames(v), null, String(v));
});

test('assertMac on win32 does not send the user to --tab', () => {
  assert.throws(() => assertMac('win32'), (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM' && !/--tab/.test(e.fix) && /clean-up/.test(e.fix));
  assert.throws(() => assertMac('linux'), (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM' && /--tab/.test(e.fix));
});
