import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDisplays, listWindows, permission, resolveCaptureSpec, captureArgs, recordArgs, ancestorPids, spawnRecord, helperJson, askRecorder, screenState, takeServedPng,
  HELPER_MISSING_FIX, HELPER_FIXES, HELPER_EXIT, recordExitError, assertMac, type RecordOptions } from '../../src/capture/mac.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import type { Display } from '../../src/core/geometry.ts';
import type { WindowInfo } from '../../src/core/targets.ts';

const fake = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
const saved = { helper: process.env.SCREENREC_MAC_HELPER, mode: process.env.FAKE_HELPER_MODE, screen: process.env.FAKE_SCREEN, home: process.env.SCREENREC_HOME };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
// an empty state folder: a real recording on this Mac must not answer these tests' helper calls
let home = '';
beforeEach(() => { process.env.SCREENREC_MAC_HELPER = fake; delete process.env.FAKE_HELPER_MODE; home = process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-')); });
afterEach(() => {
  restore('SCREENREC_MAC_HELPER', saved.helper); restore('FAKE_HELPER_MODE', saved.mode); restore('FAKE_SCREEN', saved.screen); restore('SCREENREC_HOME', saved.home);
  fs.rmSync(home, { recursive: true, force: true });
});

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

test('recordArgs passes the request folder only when there is one', () => {
  const o = { out: '/o.mov', fps: 30, maxSeconds: 1, followApp: false, ignoreApps: [], ignorePids: [], marksFile: '/m', t0Ms: 1, logFile: '/l' };
  const spec = { windowId: 7, sizePx: { width: 2, height: 2 }, cursor: false };
  assert.deepEqual(recordArgs(spec, { ...o, requestsDir: '/r' }).slice(-2), ['--requests', '/r']);
  assert.ok(!recordArgs(spec, o).includes('--requests'));
});

test('the helper reports the screen state; a helper that cannot tell gives null', async () => {
  assert.equal(await screenState(), 'awake');
  process.env.FAKE_SCREEN = 'locked';
  assert.equal(await screenState(), 'locked');
  process.env.SCREENREC_MAC_HELPER = '/nonexistent/screenrec-mac';
  assert.equal(await screenState(), null);
});

test('a helper timeout on a locked screen says the screen is locked, not that a dialog may be waiting', async () => {
  process.env.FAKE_HELPER_MODE = 'hang'; process.env.FAKE_SCREEN = 'locked';
  await assert.rejects(helperJson(['windows'], 400, null), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND'
    && /did not answer within 0 s: the screen is locked/.test(e.message) && e.fix.startsWith('Unlock the Mac'));
  process.env.FAKE_SCREEN = 'awake';
  await assert.rejects(helperJson(['windows'], 400, null), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && /permission dialog/.test(e.message));
});

/** A stand-in recorder answering requests in `dir` with `answer(args)`. Returns a stop function. */
function responder(dir: string, answer: (args: string[]) => string) {
  const t = setInterval(() => {
    for (const n of fs.readdirSync(dir).filter((f) => f.endsWith('.req'))) {
      const args = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).args;
      fs.rmSync(path.join(dir, n));
      fs.writeFileSync(path.join(dir, n.replace(/\.req$/, '.res')), answer(args));
    }
  }, 20);
  return () => clearInterval(t);
}

test('while a recorder serves requests, windows and screenshot go to it, not to a new helper process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srreq-'));
  const seen: string[][] = [];
  const stop = responder(dir, (args) => { seen.push(args); return JSON.stringify({ ok: true, windows: [], served: true }) + '\n'; });
  try {
    const r = await helperJson<{ served?: boolean }>(['windows'], 5000, { dir, alive: () => true });
    assert.equal(r.served, true); assert.deepEqual(seen, [['windows']]);
    assert.deepEqual(fs.readdirSync(dir), [], 'request and answer files are cleaned up');
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a recorder error answer becomes the same ScreenrecError a helper would give', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srreq-'));
  const stop = responder(dir, () => JSON.stringify({ ok: false, code: 'E_NO_FRAMES', message: 'no frame: the screen is locked', fix: 'Unlock the Mac.' }));
  try {
    await assert.rejects(helperJson(['screenshot'], 5000, { dir, alive: () => true }), (e: ScreenrecError) => e.code === 'E_NO_FRAMES' && e.fix === 'Unlock the Mac.');
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a recorder that is gone before it answers: the helper runs as usual', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srreq-'));
  try {
    assert.equal(await askRecorder({ dir, alive: () => false }, ['windows'], 5000), null);
    assert.deepEqual(fs.readdirSync(dir), [], 'the unanswered request is withdrawn');
    const w = await helperJson<{ windows: unknown[] }>(['windows'], 5000, { dir, alive: () => false });
    assert.equal(w.windows.length, 2, 'answered by the fake helper itself');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a recorder that never answers times out with the screen-state explanation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srreq-'));
  process.env.FAKE_SCREEN = 'asleep';
  try {
    await assert.rejects(askRecorder({ dir, alive: () => true }, ['screenshot'], 300), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && /displays are asleep/.test(e.message));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a recorder that never answers while the screen is awake is named, not blamed on a permission dialog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srreq-'));
  try {
    await assert.rejects(askRecorder({ dir, alive: () => true }, ['windows'], 300),
      (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && /the running recorder did not answer/.test(e.message) && !/permission/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing request folder falls back to the helper quietly', async () => {
  const gone = path.join(os.tmpdir(), `srreq-gone-${process.pid}`);
  assert.equal(await askRecorder({ dir: gone, alive: () => true }, ['windows'], 5000), null);
  const w = await helperJson<{ windows: unknown[] }>(['windows'], 5000, { dir: gone, alive: () => true });
  assert.equal(w.windows.length, 2);
});

test('a recorder-written PNG is taken only from the request folder and never replaces a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpng-'));
  try {
    const req = path.join(dir, 'requests'); fs.mkdirSync(req);
    const shot = path.join(req, '1-2-3.png'); fs.writeFileSync(shot, 'png');
    const out = path.join(dir, '.out.tmp.png');
    takeServedPng(shot, out, req);
    assert.equal(fs.readFileSync(out, 'utf8'), 'png'); assert.ok(!fs.existsSync(shot), 'moved, not copied');
    fs.writeFileSync(shot, 'again');
    assert.throws(() => takeServedPng(shot, out, req), (e: NodeJS.ErrnoException) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(out, 'utf8'), 'png', 'the existing file is untouched');
    const elsewhere = path.join(dir, 'secret.png'); fs.writeFileSync(elsewhere, 'x');
    assert.throws(() => takeServedPng(elsewhere, path.join(dir, 'b.png'), req), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED');
    assert.ok(fs.existsSync(elsewhere));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
