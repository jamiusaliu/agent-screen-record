import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startRecording, stopRecording, recordingStatus, addMark, realDeps, LISTING_SETTLE_MS, type RecorderDeps } from '../../src/recorder.ts';
import { superviseSpawn } from '../../src/capture/supervise.ts';
import { readSidecar } from '../../src/core/sidecar.ts';
import { readState, writeState } from '../../src/core/state.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import { helperJson, listWindows } from '../../src/capture/mac.ts';
import { makeVideo } from './helpers.ts';

const fake = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
const fakeCdp = new URL('../fixtures/fake-cdp-worker.mjs', import.meta.url).pathname;
let cwd = '';
let home = '';
beforeEach(() => {
  process.env.SCREENREC_MAC_HELPER = fake; delete process.env.FAKE_HELPER_MODE;
  home = process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
});
afterEach(() => { for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true }); });
const deps = (over: Partial<RecorderDeps> = {}): RecorderDeps => ({ ...realDeps, platform: 'darwin', ...over });
const win = { kind: 'window' as const, app: 'Finder', followApp: false, ignoreApps: [] };
const opts = (extra = {}) => ({ target: win, fps: 30, cursor: false, maxMs: 60000, meta: true, cwd, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Event-driven: resolves once the current recording's recorder (its supervisor) has exited. */
async function recorderGone(capMs = 30_000) {
  const pid = readState()?.pid;
  for (const end = Date.now() + capMs; pid && pidAlive(pid) && Date.now() < end; ) await sleep(50);
  assert.ok(!pid || !pidAlive(pid), 'recorder exited');
}

test('start, status, mark, double start refused, stop finalises mp4 and sidecar', async () => {
  const s = await startRecording(opts(), deps());
  assert.equal(s.worker, 'mac'); assert.ok(s.out.startsWith(path.join(cwd, 'recordings')));
  assert.equal(fs.readFileSync(path.join(cwd, 'recordings', '.gitignore'), 'utf8').trim(), '*');
  assert.equal((await recordingStatus(deps())).recording, true);
  await sleep(600);
  addMark('opened Downloads', deps());
  await assert.rejects(startRecording(opts(), deps()), (e: ScreenrecError) => e.code === 'E_ALREADY_RECORDING');
  await sleep(600);
  const r = await stopRecording(deps());
  assert.ok(fs.existsSync(r.out)); assert.ok(r.durationSec > 0.5, `duration ${r.durationSec}`);
  assert.equal(readSidecar(r.sidecar!)!.marks[0].text, 'opened Downloads');
  assert.equal(readState(), null);
  assert.deepEqual(fs.readdirSync(path.dirname(r.out)).filter((f) => /\.rec\.|marks/.test(f)), [], 'raw, marks and log removed');
});

test('target closes before stop: status saves it, stop still reports it with the reason', async () => {
  process.env.FAKE_HELPER_MODE = 'target-closes';
  await startRecording(opts(), deps());
  await recorderGone();  // the recorder ends on its own; wait for that, not a fixed time
  const st = await recordingStatus(deps());
  assert.equal(st.recording, false);
  assert.ok(st.recovered && fs.existsSync(st.recovered.out)); assert.match(st.text, new RegExp(st.recovered.out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const r = await stopRecording(deps());
  assert.ok(fs.existsSync(r.out)); assert.equal(r.reason, 'target-closed'); assert.equal(r.recovered, true);
  assert.equal(r.out, st.recovered.out);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NOT_RECORDING');
});

test('status finalises a crashed recording; the next start reports it and clears it', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  await makeVideo(raw, 'moving', { seconds: 1 });
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  const st = await recordingStatus(deps());
  assert.equal(st.recording, false); assert.equal(st.recovered?.out, path.join(cwd, 'old.mp4'));
  assert.ok(fs.existsSync(path.join(cwd, 'old.mp4'))); assert.equal(fs.existsSync(raw), false);
  assert.equal((await recordingStatus(deps())).recovered?.out, path.join(cwd, 'old.mp4'), 'status repeats it, it does not re-finalise');
  const s = await startRecording(opts(), deps());
  assert.equal(s.recovered?.out, path.join(cwd, 'old.mp4'));
  await sleep(500);
  const r = await stopRecording(deps());
  assert.notEqual(r.recovered, true, 'the new recording, not the recovered one');
});

test('a header-only raw file (killed before the first fragment) is E_NO_FRAMES, raw kept, no mp4', async () => {
  process.env.FAKE_HELPER_MODE = 'header-only';
  const out = path.join(cwd, 'h.mp4');
  await startRecording(opts({ out }), deps());
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES' && e.message.includes(path.join(cwd, 'h.rec.mov')));
  assert.equal(fs.existsSync(out), false);
  assert.ok(fs.existsSync(path.join(cwd, 'h.rec.mov')), 'raw kept');
  assert.deepEqual(fs.readdirSync(cwd).filter((f) => /tmp/.test(f)), [], 'no temp file left');
  assert.equal(readState(), null);
});

test('a helper that crashes in its first second: status reports it, stop gives E_NO_FRAMES naming the raw', async () => {
  process.env.FAKE_HELPER_MODE = 'crash-early';
  const out = path.join(cwd, 'c.mp4');
  await startRecording(opts({ out }), deps());
  await recorderGone();  // the recorder ends on its own; wait for that, not a fixed time
  const st = await recordingStatus(deps());
  assert.equal(st.recording, false); assert.match(st.text, /could not recover/);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES' && e.message.includes('c.rec.mov'));
  assert.equal(fs.existsSync(out), false); assert.ok(fs.existsSync(path.join(cwd, 'c.rec.mov')));
  assert.equal(readState(), null);
});

const logLines = (out: string) => { try { return fs.readFileSync(out.replace(/\.mp4$/, '.rec.log'), 'utf8').split('\n'); } catch { return []; } };

/** Waits for the supervisor's first-frame line, then adds a mark; returns what the sidecar should say. */
async function markAfterFirstFrame(mode: string) {
  process.env.FAKE_HELPER_MODE = mode;
  const s = await startRecording(opts(), deps());
  const t0 = readState()!.startedAt;
  let ff: { ms: number } | undefined;
  for (let i = 0; i < 600 && !ff; i++) {
    const line = logLines(s.out).find((l) => l.includes('"first-frame"'));
    if (line) ff = JSON.parse(line); else await sleep(50);
  }
  assert.ok(ff, 'first-frame line logged');
  const seenAt = Date.now();
  await sleep(300);
  const before = Date.now(); addMark('after the first frame', deps()); const after = Date.now();
  const r = await stopRecording(deps());
  const side = readSidecar(r.sidecar!)!;
  return { ff: ff.ms, t0, seenAt, before, after, mark: side.marks[0].t, startedAt: Date.parse(side.startedAt) };
}

const near = (t: number, lo: number, hi: number) => t >= lo - 0.002 && t <= hi + 0.002;

test('mac marks are timed from the first frame seen in the log', async () => {
  const r = await markAfterFirstFrame('late-first-frame');
  assert.ok(r.ff > r.t0 + 1000, 'the fake sends first-frame 1.5 s after started');
  assert.ok(near(r.mark, (r.before - r.ff) / 1000, (r.after - r.ff) / 1000), `mark ${r.mark} s, first frame at +${r.ff - r.t0} ms`);
  assert.equal(r.startedAt, r.ff, 'sidecar startedAt is the first frame');
});

test('mac marks use the first-frame ms field when the helper sends one', async () => {
  const r = await markAfterFirstFrame('first-frame-ms');
  assert.ok(r.seenAt - r.ff >= 900, 'the helper ms (started + 0.5 s) is kept, not replaced by the time the line was seen');
  assert.ok(near(r.mark, (r.before - r.ff) / 1000, (r.after - r.ff) / 1000), `mark ${r.mark} s`);
  assert.equal(r.startedAt, r.ff);
});

test('start refuses an --out that already exists, or its sidecar when meta is on', async () => {
  const out = path.join(cwd, 'taken.mp4');
  fs.writeFileSync(out, 'mine');
  await assert.rejects(startRecording(opts({ out }), deps()), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.message.includes(out) && /--out/.test(e.fix));
  fs.rmSync(out); fs.writeFileSync(path.join(cwd, 'taken.json'), 'mine');
  await assert.rejects(startRecording(opts({ out }), deps()), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.message.includes('taken.json'));
  assert.equal(fs.readFileSync(path.join(cwd, 'taken.json'), 'utf8'), 'mine');
  assert.equal(readState(), null);
});

test('recovery never overwrites an existing file: it picks a -2 name', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  await makeVideo(raw, 'moving', { seconds: 1 });
  fs.writeFileSync(path.join(cwd, 'old.mp4'), 'mine');
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  const s = await startRecording(opts(), deps());
  assert.equal(s.recovered?.out, path.join(cwd, 'old-2.mp4'));
  assert.equal(s.recovered?.sidecar, path.join(cwd, 'old-2.json'));
  assert.equal(fs.readFileSync(path.join(cwd, 'old.mp4'), 'utf8'), 'mine');
  await sleep(300); await stopRecording(deps());
});

test('a failed recovery is a start warning naming the kept raw file', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  fs.writeFileSync(raw, Buffer.from('not a video at all'));
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  const s = await startRecording(opts(), deps());
  assert.equal(s.recovered, undefined);
  assert.match(s.warnings.join('\n'), new RegExp(`could not recover ${path.join(cwd, 'old.mp4')}: .*; raw kept at ${raw}`));
  assert.ok(fs.existsSync(raw));
  await sleep(300); await stopRecording(deps());
});

test('a successful recovery is still reported when the new start fails', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  await makeVideo(raw, 'moving', { seconds: 1 });
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  process.env.FAKE_HELPER_MODE = 'no-permission';
  await assert.rejects(startRecording(opts(), deps()),
    (e: ScreenrecError) => e.code === 'E_PERMISSION' && e.message.includes(`recovered to ${path.join(cwd, 'old.mp4')}`));
  assert.ok(fs.existsSync(path.join(cwd, 'old.mp4')));
});

test('two concurrent starts: exactly one wins, the other is E_ALREADY_RECORDING', async () => {
  process.env.FAKE_HELPER_MODE = 'slow-start';
  const rs = await Promise.allSettled([startRecording(opts(), deps()), startRecording(opts({ out: path.join(cwd, 'b.mp4') }), deps())]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(lost.reason.code, 'E_ALREADY_RECORDING');
  await sleep(300); await stopRecording(deps());
  assert.equal(fs.existsSync(path.join(home, 'start.lock')), false, 'lock released');
});

test('startup liveness does not go through the slow ps check', async () => {
  let calls = 0;
  const d = deps({ isAlive: (pid) => { calls++; return realDeps.isAlive(pid); } });
  process.env.FAKE_HELPER_MODE = 'slow-start';
  await startRecording(opts(), d);
  assert.equal(calls, 0, 'waitReady polled isAlive');
  await sleep(300); await stopRecording(deps());
});

test('the supervisor\'s own errors reach the log', async () => {
  const log = path.join(cwd, 'sup.log');
  superviseSpawn('', [], log);
  for (let i = 0; i < 100 && !fs.readFileSync(log, 'utf8').includes('ERR_INVALID_ARG_VALUE'); i++) await sleep(50);
  assert.match(fs.readFileSync(log, 'utf8'), /ERR_INVALID_ARG_VALUE/);
});

test('no frames gives E_NO_FRAMES and clears state', async () => {
  process.env.FAKE_HELPER_MODE = 'no-frames';
  await startRecording(opts(), deps());
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES');
  assert.equal(readState(), null);
});

test('no frames: a plain E_NO_FRAMES does not blame the screen', async () => {
  process.env.FAKE_HELPER_MODE = 'no-frames';
  const s = await startRecording(opts(), deps());
  assert.ok(!s.warnings.some((w) => /locked|asleep/.test(w)), s.warnings.join('; '));
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES' && !/locked|asleep/.test(e.message));
});

test('a recording on a locked screen warns at start and names the lock in E_NO_FRAMES', async () => {
  process.env.FAKE_HELPER_MODE = 'no-frames-locked';
  const s = await startRecording(opts(), deps());
  assert.ok(s.warnings.includes('the screen is locked: nothing is captured until it is unlocked'), s.warnings.join('; '));
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES' &&
    e.message === 'The recording captured no frames: the screen was locked' && /Unlock the Mac/.test(e.fix) && /caffeinate -d/.test(e.fix));
  assert.equal(readState(), null);
});

test('writer failure (exit 6) gives E_HELPER_CRASHED with an output folder fix and clears state', async () => {
  process.env.FAKE_HELPER_MODE = 'writer-fails';
  await startRecording(opts(), deps());
  await recorderGone();  // the recorder ends on its own; wait for that, not a fixed time
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_HELPER_CRASHED' && /folder/.test(e.fix));
  assert.equal(readState(), null);
});

test('helper permission error surfaces at start with the fix', async () => {
  process.env.FAKE_HELPER_MODE = 'no-permission';
  await assert.rejects(startRecording(opts(), deps()), (e: ScreenrecError) => e.code === 'E_PERMISSION' && /Screen Recording/.test(e.fix));
});

test('a record-time helper error is passed through with its own fix, and leaves no state', async () => {
  process.env.FAKE_HELPER_MODE = 'record-locked';
  await assert.rejects(startRecording(opts(), deps()),
    (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && /locked/.test(e.message) && e.fix.startsWith('Unlock the Mac and try again.'));
  assert.equal(readState(), null);
});

test('start returns only after the helper reported started', async () => {
  process.env.FAKE_HELPER_MODE = 'slow-start';
  const t0 = Date.now();
  const s = await startRecording(opts(), deps());
  assert.ok(Date.now() - t0 >= 1100, `returned after ${Date.now() - t0} ms`);
  assert.equal(s.worker, 'mac');
  await sleep(500);
  await stopRecording(deps());
});

test('stale state from a crash is recovered on the next start', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  await makeVideo(raw, 'moving', { seconds: 1 });
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  const s = await startRecording(opts(), deps());
  assert.ok(s.recovered && fs.existsSync(s.recovered.out));
  await stopRecording(deps());
});

test('--no-meta writes no sidecar', async () => {
  await startRecording(opts({ meta: false }), deps());
  await sleep(800);
  const r = await stopRecording(deps());
  assert.equal(r.sidecar, undefined);
  assert.equal(fs.existsSync(r.out.replace(/\.mp4$/, '.json')), false);
});

test('tab target falls back to the Chrome window when remote debugging is off and the tab is active', async () => {
  const noCdp = async () => { throw new ScreenrecError('E_CDP_UNAVAILABLE', 'off', 'enable'); };
  const d = deps({ cdp: { ...realDeps.cdp, resolveEndpoint: noCdp }, chromeActiveTabs: async () => [{ windowIndex: 1, title: 'Agent Docs', url: 'https://docs.test/a' }] });
  const s = await startRecording(opts({ target: { kind: 'tab', mode: 'url', pattern: 'docs.test' } }), d);
  assert.equal(s.worker, 'mac'); assert.match(s.warnings.join(' '), /remote debugging is off/);
  await sleep(800); await stopRecording(d);
  await assert.rejects(startRecording(opts({ target: { kind: 'tab', mode: 'newest' } }), d), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

// CDP worker startup, with a fake worker standing in for src/capture/cdp/worker.ts
const tab = { kind: 'tab' as const, mode: 'newest' as const };
const cdpDeps = (mode: string, over: Partial<RecorderDeps> = {}) => deps({
  isAlive: pidAlive,
  cdp: { resolveEndpoint: async () => ({ wsUrl: 'ws://127.0.0.1:1/devtools/browser/x' }), spawnWorker: (_cfg, log) => superviseSpawn(process.execPath, [fakeCdp, mode], log) },
  ...over,
});

test('tab start waits for the worker to say ready', async () => {
  const d = cdpDeps('ready-late');
  const t0 = Date.now();
  const s = await startRecording(opts({ target: tab }), d);
  assert.ok(Date.now() - t0 >= 1100, `returned after ${Date.now() - t0} ms`);
  assert.equal(s.worker, 'cdp');
  assert.equal((await recordingStatus(d)).recording, true);
  d.signal(s.pid, 'SIGKILL');
  for (let i = 0; i < 50 && pidAlive(s.pid); i++) await sleep(50);
});

test('a worker setup error becomes that ScreenrecError, with no state left', async () => {
  await assert.rejects(startRecording(opts({ target: tab }), cdpDeps('fails')),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE' && /Click Allow/.test(e.fix));
  assert.equal(readState(), null);
});

test('a worker that never gets ready is killed after the timeout and gives E_CDP_UNAVAILABLE', async () => {
  let clock = 0;  // virtual clock: each poll advances it by a second, so the 20 s timeout passes quickly
  let pid = 0;
  const d = cdpDeps('hang', {
    now: () => clock,
    sleep: async (ms) => { clock += 1000; await sleep(Math.min(ms, 20)); },
  });
  const spawnWorker = d.cdp.spawnWorker;
  d.cdp = { ...d.cdp, spawnWorker: (cfg, log) => (pid = spawnWorker(cfg, log)) };
  await assert.rejects(startRecording(opts({ target: tab }), d), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(50);
  assert.equal(pidAlive(pid), false, 'worker killed');
  assert.equal(readState(), null);
});

test('window capture on another platform is E_UNSUPPORTED_PLATFORM', async () => {
  await assert.rejects(startRecording(opts(), deps({ platform: 'linux' })), (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM');
});

test('addMark after status recovered the recording is E_NOT_RECORDING and writes no marks file', async () => {
  process.env.FAKE_HELPER_MODE = 'target-closes';
  const s = await startRecording(opts(), deps());
  await recorderGone();  // the recorder ends on its own; wait for that, not a fixed time
  assert.ok((await recordingStatus(deps())).recovered);
  assert.throws(() => addMark('too late', deps()), (e: ScreenrecError) => e.code === 'E_NOT_RECORDING');
  assert.equal(fs.existsSync(s.out.replace(/\.mp4$/, '.marks.jsonl')), false);
  await stopRecording(deps());
});

test('status reports the human target label, not a JSON-encoded target', async () => {
  const s = await startRecording(opts(), deps());
  const st = await recordingStatus(deps());
  assert.equal(st.target, 'Finder: Downloads'); assert.equal(st.target, s.target);
  await sleep(300); await stopRecording(deps());
});

test('start --force records over an existing --out (and its sidecar) only when stop has a playable file', async () => {
  const out = path.join(cwd, 'taken.mp4'); const side = path.join(cwd, 'taken.json');
  fs.writeFileSync(out, 'mine'); fs.writeFileSync(side, 'mine');
  const s = await startRecording(opts({ out, force: true }), deps());
  assert.equal(s.out, out);
  assert.equal(fs.readFileSync(out, 'utf8'), 'mine', 'the old file stays until stop has a good recording');
  await sleep(600);
  const r = await stopRecording(deps());
  assert.equal(r.out, out); assert.equal(r.sidecar, side);
  assert.ok(r.durationSec > 0.3, `duration ${r.durationSec}`);
  assert.equal(readSidecar(side)!.version, 1);
  assert.ok(!fs.existsSync(path.join(cwd, 'taken-2.mp4')), 'no -2 name with --force');
});

test('start --force without --out is refused before anything starts', async () => {
  await assert.rejects(startRecording(opts({ force: true }), deps()),
    (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.fix === '--force only applies with --out.');
  assert.equal(readState(), null);
});

test('a directory that appears at a forced --out during recording: stop gives a ScreenrecError and cleans up', async () => {
  const out = path.join(cwd, 'gone.mp4');
  await startRecording(opts({ out, force: true }), deps());
  fs.mkdirSync(out);
  await sleep(300);
  addMark('a step', deps());
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: unknown) => e instanceof ScreenrecError && e.message.includes(out) && /directory/.test(e.message) && e.message.includes('gone.marks.jsonl'));
  assert.equal(readState(), null);
  const left = fs.readdirSync(cwd).filter((f) => f !== 'gone.mp4');
  assert.deepEqual(left.filter((f) => /\.tmp\.|\.rec\.log/.test(f)), [], `temp files cleaned: ${left.join(', ')}`);
  assert.ok(left.some((f) => /^gone\.rec\./.test(f)), 'the raw recording is kept and named in the error');
  assert.ok(left.includes('gone.marks.jsonl'), 'the marks are kept with the raw recording');
});

test('start --force --no-meta removes the stale sidecar of the replaced recording', async () => {
  const out = path.join(cwd, 'old.mp4'); const side = path.join(cwd, 'old.json');
  fs.writeFileSync(out, 'mine');
  fs.writeFileSync(side, JSON.stringify({ version: 1, target: win, startedAt: '2026-10-17T00:00:00Z', durationSec: 1, marks: [] }));
  await startRecording(opts({ out, force: true, meta: false }), deps());
  await sleep(600);
  const r = await stopRecording(deps());
  assert.equal(r.out, out); assert.equal(r.sidecar, undefined);
  assert.ok(!fs.existsSync(side), 'stale sidecar removed');
});

test('start --force --no-meta on a new path leaves an unrelated json alone', async () => {
  const out = path.join(cwd, 'new.mp4'); const side = path.join(cwd, 'new.json');
  fs.writeFileSync(side, JSON.stringify({ version: 1, target: win, startedAt: '2026-10-17T00:00:00Z', durationSec: 1, marks: [] }));
  await startRecording(opts({ out, force: true, meta: false }), deps());
  await sleep(600);
  await stopRecording(deps());
  assert.ok(fs.existsSync(side), 'nothing was replaced, so nothing is removed');
});

test('start refuses an explicit --out in a missing folder or under a file, before the helper starts', async () => {
  const missing = path.join(cwd, 'no', 'such');
  await assert.rejects(startRecording(opts({ out: path.join(missing, 'a.mp4') }), deps()), (e: ScreenrecError) =>
    e.code === 'E_BAD_ARGS' && e.message === `folder does not exist: ${missing}` && e.fix === 'Create the folder first or choose another --out.');
  assert.ok(!fs.existsSync(path.join(cwd, 'no')), 'no folder created');
  const file = path.join(cwd, 'plain'); fs.writeFileSync(file, '');
  await assert.rejects(startRecording(opts({ out: path.join(file, 'sub', 'a.mp4') }), deps()), (e: ScreenrecError) =>
    e.code === 'E_BAD_ARGS' && e.message === `not a folder: ${file}`);
  assert.equal(readState(), null);
});

test('start with a cwd of / or an unwritable cwd records into ~/Movies/screenrec', async () => {
  const oldHome = process.env.HOME;
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-')); fs.chmodSync(ro, 0o555);
  process.env.HOME = path.join(cwd, 'home');
  try {
    for (const c of ['/', ro]) {
      const s = await startRecording(opts({ cwd: c }), deps());
      assert.equal(path.dirname(s.out), path.join(cwd, 'home', 'Movies', 'screenrec'), c);
      await sleep(300);
      await stopRecording(deps());
    }
    assert.deepEqual(fs.readdirSync(ro), []);
  } finally { process.env.HOME = oldHome; fs.chmodSync(ro, 0o755); fs.rmSync(ro, { recursive: true, force: true }); }
});

test('start without ffmpeg fails with E_NO_FFMPEG before anything is recorded', async () => {
  const saved = process.env.SCREENREC_FFMPEG;
  process.env.SCREENREC_FFMPEG = path.join(cwd, 'no-such-ffmpeg');
  let spawned = false;
  try {
    await assert.rejects(startRecording(opts(), deps({ mac: { ...realDeps.mac, spawnRecord: () => { spawned = true; throw new Error('must not spawn'); } } })),
      (e: ScreenrecError) => e.code === 'E_NO_FFMPEG');
  } finally { if (saved === undefined) delete process.env.SCREENREC_FFMPEG; else process.env.SCREENREC_FFMPEG = saved; }
  assert.equal(spawned, false);
  assert.equal(readState(), null);
  assert.ok(!fs.existsSync(path.join(cwd, 'recordings')) || fs.readdirSync(path.join(cwd, 'recordings')).every((f) => f === '.gitignore'));
});

test('ffmpeg gone by stop: E_NO_FFMPEG (not E_NO_FRAMES), raw and step notes kept and named', async () => {
  const s = await startRecording(opts(), deps());
  await sleep(700);
  addMark('opened Downloads', deps());
  const marks = s.out.replace(/\.mp4$/, '.marks.jsonl');
  await sleep(800);
  const saved = process.env.SCREENREC_FFMPEG;
  process.env.SCREENREC_FFMPEG = path.join(cwd, 'no-such-ffmpeg');
  try {
    await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FFMPEG' && /raw kept at/.test(e.message)
      && e.message.includes(`step notes kept at ${marks}`));
  } finally { if (saved === undefined) delete process.env.SCREENREC_FFMPEG; else process.env.SCREENREC_FFMPEG = saved; }
  assert.equal(readState(), null);
  assert.ok(fs.existsSync(s.out.replace(/\.mp4$/, '.rec.mov')), 'raw kept');
  assert.match(fs.readFileSync(marks, 'utf8'), /opened Downloads/, 'step notes kept');
  assert.ok(!fs.existsSync(s.out));
});

test('on win32 every start is E_UNSUPPORTED_PLATFORM, a tab too, before any endpoint or broker is touched', async () => {
  let touched = false;
  const d = deps({ platform: 'win32', cdp: { ...realDeps.cdp, resolveEndpoint: async () => { touched = true; throw new Error('no'); } } });
  await assert.rejects(startRecording(opts({ target: { kind: 'tab', mode: 'newest' } }), d),
    (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM' && /Windows/.test(e.message));
  await assert.rejects(startRecording(opts(), d), (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM');
  assert.equal(touched, false);
  assert.equal(readState(), null);
});

test('start validates fps, max and the out extension in Node before anything starts', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ fps: 0 }, /--fps/], [{ fps: 29.97 }, /--fps/], [{ fps: 240 }, /--fps/], [{ fps: NaN }, /--fps/],
    [{ maxMs: 0 }, /--max/], [{ maxMs: 25 * 3600_000 }, /--max/], [{ maxMs: NaN }, /--max/],
    [{ out: path.join(cwd, 'clip.mov') }, /\.mp4/],
  ];
  for (const [extra, re] of cases) {
    await assert.rejects(startRecording(opts(extra), deps({ mac: { ...realDeps.mac, spawnRecord: () => { throw new Error('must not spawn'); } } })),
      (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && re.test(e.message), JSON.stringify(extra));
  }
  assert.equal(readState(), null);
});

test('status reports the target state from the helper: hidden while held, visible again after', async () => {
  const s = await startRecording(opts(), deps());
  const log = s.out.replace(/\.mp4$/, '.rec.log');
  const st0 = await recordingStatus(deps());
  assert.equal(st0.targetState, 'visible');
  fs.appendFileSync(log, JSON.stringify({ event: 'warning', message: 'window is hidden, minimized or closed; holding the last frame' }) + '\n');
  const st1 = await recordingStatus(deps());
  assert.equal(st1.targetState, 'hidden');
  assert.match(st1.text, /hidden/);
  fs.appendFileSync(log, JSON.stringify({ event: 'warning', message: 'window is visible again' }) + '\n');
  assert.equal((await recordingStatus(deps())).targetState, 'visible');
  await sleep(600);
  await stopRecording(deps());
});

test('start without ffprobe also fails with E_NO_FFMPEG before anything is recorded', async () => {
  const saved = process.env.SCREENREC_FFPROBE;
  process.env.SCREENREC_FFPROBE = path.join(cwd, 'no-such-ffprobe');
  try {
    await assert.rejects(startRecording(opts(), deps({ mac: { ...realDeps.mac, spawnRecord: () => { throw new Error('must not spawn'); } } })),
      (e: ScreenrecError) => e.code === 'E_NO_FFMPEG' && /ffprobe/.test(e.message));
  } finally { if (saved === undefined) delete process.env.SCREENREC_FFPROBE; else process.env.SCREENREC_FFPROBE = saved; }
  assert.equal(readState(), null);
});

test('while recording, window listings go to the recorder; one that never answers times out naming a locked screen', async () => {
  await startRecording(opts(), deps());
  const dir = readState()!.requests!;
  assert.ok(fs.statSync(dir).isDirectory()); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal((await helperJson<{ served?: boolean }>(['windows'])).served, true);
  assert.equal((await listWindows()).length, 2);
  await sleep(300);
  await stopRecording(deps());
  assert.equal((await helperJson<{ served?: boolean }>(['windows'])).served, undefined, 'no recording: the helper runs itself');

  process.env.FAKE_HELPER_MODE = 'serve-hang';
  await startRecording(opts(), deps());
  process.env.FAKE_SCREEN = 'locked';
  try {
    await assert.rejects(helperJson(['windows'], 600), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && /the screen is locked/.test(e.message));
  } finally { delete process.env.FAKE_SCREEN; }
  await sleep(300);
  await stopRecording(deps());
});

test('the recorder starts only after a window listing has had time to quit; display targets list no windows', async () => {
  const events: string[] = [];
  const spy = (): RecorderDeps => deps({
    sleep: async (ms) => { if (ms >= 100) events.push(`sleep ${ms}`); await realDeps.sleep(ms); },
    mac: { ...realDeps.mac,
      listWindows: async () => { events.push('windows'); return realDeps.mac.listWindows(); },
      spawnRecord: (spec, o) => { events.push('spawn'); return realDeps.mac.spawnRecord(spec, o); } },
  });
  await startRecording(opts(), spy());
  assert.equal(events[0], 'windows'); assert.equal(events.at(-1), 'spawn');
  const wait = Number(events.find((e) => e.startsWith('sleep'))?.split(' ')[1]);
  assert.ok(wait > LISTING_SETTLE_MS - 300 && wait <= LISTING_SETTLE_MS, `settle wait ${wait}`);
  await sleep(300);
  await stopRecording(deps());
  events.length = 0;
  await startRecording(opts({ target: { kind: 'display', display: 'main' } }), spy());
  assert.deepEqual(events, ['spawn'], 'no window listing and no wait for a display');
  await sleep(300);
  await stopRecording(deps());
});
