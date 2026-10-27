import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';

const bin = new URL('../../bin/screenrec-mac', import.meta.url).pathname;
const skip = process.platform !== 'darwin' || !fs.existsSync(bin) ? 'needs macOS and npm run build:native' : false;
// Listen at spawn time: a helper that exits early must not leave the test waiting forever.
const exitCode = (p: ChildProcess) => new Promise<number>((r) => p.on('close', (c) => r(c ?? -1)));
// Resolves on the helper's first-frame event; rejects with its output if it exits first, so a helper
// that dies during startup fails the test instead of hanging it.
function untilFirstFrame(p: ChildProcess, exited: Promise<number>, out: { text: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    p.stdout!.on('data', (b) => { out.text += b; if (out.text.includes('"first-frame"')) resolve(); });
    exited.then((code) => reject(new Error(`helper exited ${code} before first-frame: ${out.text}`)));
  });
}
const lines = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const mainDisplay = () => JSON.parse(execFileSync(bin, ['displays'], { encoding: 'utf8' })).displays.find((x: { main: boolean }) => x.main);
const duration = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));

// Records the main display at half size for 2 s after the first frame, then stops it with `stop`.
async function recordAndStop(t: { after: (fn: () => void) => void }, stop: (p: ChildProcess) => void) {
  const d = mainDisplay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'a.mov');
  const w = Math.floor((d.width * d.scale) / 4) * 2, h = Math.floor((d.height * d.scale) / 4) * 2;
  const p = spawn(bin, ['record', '--display-id', String(d.id), '--size', `${w},${h}`, '--fps', '30', '--out', out, '--max-seconds', '20']);
  const exited = exitCode(p);
  const output = { text: '' };
  // Count from the first frame, not from spawn: startup takes 0.4 to 1.5 s (more with two displays).
  await untilFirstFrame(p, exited, output);
  await new Promise((r) => setTimeout(r, 2000));
  stop(p);
  const code = await exited;
  return { code, ev: lines(output.text), dur: duration(out) };
}

for (const [name, stop, reason] of [
  ['SIGINT', (p: ChildProcess) => p.kill('SIGINT'), 'signal'],
  ['SIGTERM', (p: ChildProcess) => p.kill('SIGTERM'), 'signal'],
  ['a stop line on stdin', (p: ChildProcess) => p.stdin!.write('stop\n'), 'stdin'],
] as const) {
  test(`records the main display for about 2 s and stops on ${name} with a playable file`, { skip }, async (t) => {
    const { code, ev, dur } = await recordAndStop(t, stop);
    assert.equal(ev[0].event, 'started');
    const ff = ev.find((e: { event: string }) => e.event === 'first-frame');
    assert.ok(ff && Number.isInteger(ff.ms) && Math.abs(Date.now() - 2000 - ff.ms) < 3000, `first-frame ms ${ff?.ms}`);
    assert.equal(ev.at(-1).event, 'stopped'); assert.equal(ev.at(-1).reason, reason);
    assert.equal(code, 0);
    assert.ok(dur > 1.8 && dur < 3.5, `duration ${dur}`);
  });
}

test('a ScreenCaptureKit query that never answers fails fast with E_HELPER_CRASHED', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'lock');
  // Hold the helper's query lock so it cannot reach ScreenCaptureKit, standing in for a hung query.
  const holder = spawn('perl', ['-e', 'use Fcntl ":flock"; open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $| = 1; print "held\n"; sleep 30', lock]);
  t.after(() => holder.kill());
  await new Promise((r) => holder.stdout!.once('data', r));
  const started = Date.now();
  const p = spawn(bin, ['record', '--display-id', '1', '--size', '640,400', '--out', path.join(dir, 'a.mov')],
    { env: { ...process.env, SCREENREC_MAC_LOCK: lock, SCREENREC_MAC_START_TIMEOUT: '2' } });
  const exited = exitCode(p);
  let stdout = ''; p.stdout!.on('data', (b) => (stdout += b));
  assert.equal(await exited, 1);
  const last = lines(stdout).at(-1);
  assert.equal(last.ok, false); assert.equal(last.code, 'E_HELPER_CRASHED');
  assert.ok(Date.now() - started < 6000);
});

test('max-seconds stops on its own', { skip }, async (t) => {
  const d = mainDisplay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recmax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'a.mov');
  const p = spawn(bin, ['record', '--display-id', String(d.id), '--size', '640,400', '--out', out, '--max-seconds', '1.5']);
  const exited = exitCode(p);
  let stdout = ''; p.stdout!.on('data', (b) => (stdout += b));
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(lines(stdout).at(-1).reason, 'max');
});

test('--out into a missing folder exits 6 with E_HELPER_CRASHED before capturing', { skip }, () => {
  const r = spawnSync(bin, ['record', '--display-id', '1', '--size', '640,400', '--out', '/nonexistent-screenrec-dir/a.mov'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 6, `exit ${r.status} signal ${r.signal} stdout ${r.stdout}`);
  const last = lines(r.stdout).at(-1);
  assert.equal(last.code, 'E_HELPER_CRASHED'); assert.match(last.fix, /output folder/);
});

test('a signal during startup stops cleanly with a stopped event and exit 5', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recsig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'lock');
  // Hold the query lock so startup stalls, then interrupt it.
  const holder = spawn('perl', ['-e', 'use Fcntl ":flock"; open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $| = 1; print "held\n"; sleep 30', lock]);
  t.after(() => holder.kill());
  await new Promise((r) => holder.stdout!.once('data', r));
  const p = spawn(bin, ['record', '--display-id', '1', '--size', '640,400', '--out', path.join(dir, 'a.mov')], { env: { ...process.env, SCREENREC_MAC_LOCK: lock } });
  const exited = exitCode(p);
  let stdout = ''; p.stdout!.on('data', (b) => (stdout += b));
  await new Promise((r) => setTimeout(r, 700));
  p.kill('SIGINT');
  assert.equal(await exited, 5);
  const last = lines(stdout).at(-1);
  assert.equal(last.event, 'stopped'); assert.equal(last.reason, 'signal'); assert.equal(last.frames, 0);
});

test('a SIGKILLed recording still leaves a playable fragmented mov', { skip }, async (t) => {
  const d = mainDisplay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reckill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'a.mov');
  const p = spawn(bin, ['record', '--display-id', String(d.id), '--size', '640,400', '--out', out, '--max-seconds', '20']);
  const exited = exitCode(p);
  // The first fragment (and its moov) reaches disk 2.5 to 3 s after the first frame (2 s fragment
  // interval plus encoder flush); a kill before that leaves no playable file, so kill 4 s after first-frame.
  await untilFirstFrame(p, exited, { text: '' });
  await new Promise((r) => setTimeout(r, 4000));
  p.kill('SIGKILL');
  await exited;
  const dur = duration(out);
  assert.ok(dur > 0, `duration ${dur}`);
});
