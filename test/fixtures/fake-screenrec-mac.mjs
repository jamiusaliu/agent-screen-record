#!/usr/bin/env node
// Mimics screenrec-mac for tests. Behaviour is chosen with FAKE_HELPER_MODE:
// ok | hang | locked | no-permission | no-frames | target-closes | writer-fails | record-locked | slow-start
// | header-only (killed on stop before any fragment) | crash-early (dies 300 ms in, header only)
// | late-first-frame (first-frame 1.5 s after started, no ms) | first-frame-ms (same, but ms says 0.5 s after started)
// | bad-png (screenshot reports ok but writes bytes that are not a PNG)
// | no-frames-locked (warns that the screen is locked before started, then stops with no frames and screen: locked)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const [cmd, ...rest] = process.argv.slice(2);
const mode = process.env.FAKE_HELPER_MODE ?? 'ok';
const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (k) => { const i = rest.indexOf(`--${k}`); return i === -1 ? undefined : rest[i + 1]; };
const locked = { ok: false, code: 'E_TARGET_NOT_FOUND', message: 'No displays are available: the screen is locked',
  fix: 'Unlock the Mac and try again. For unattended runs, keep the displays awake, for example with "caffeinate -d" running alongside.' };

// Each mode sets up its file and signal handlers BEFORE it prints "started", so a stop that arrives
// right after start (as it can on a loaded machine) meets a fully set-up recorder.
function record() {
  if (mode === 'record-locked') { print(locked); process.exit(1); }
  const started = () => { const at = Date.now(); print({ event: 'started', width: 320, height: 240 }); return at; };
  if (mode === 'header-only' || mode === 'crash-early') {
    // a fragmented mov cut before its first fragment: what a helper killed in its first seconds leaves behind
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakehdr-')), 'a.mov');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mov', tmp]);
    const buf = fs.readFileSync(tmp);
    fs.writeFileSync(flag('out'), buf.subarray(0, buf.indexOf('moof') - 4));
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    const die = () => process.kill(process.pid, 'SIGKILL');
    process.on('SIGINT', die);
    setInterval(() => {}, 1000);
    started();
    if (mode === 'crash-early') setTimeout(die, 300);
    return;
  }
  if (mode === 'no-frames' || mode === 'no-frames-locked') {
    const screen = mode === 'no-frames-locked' ? { screen: 'locked' } : {};
    process.on('SIGINT', () => { print({ event: 'stopped', reason: 'signal', frames: 0, ...screen }); process.exit(5); });
    setInterval(() => {}, 1000);
    if (mode === 'no-frames-locked') print({ event: 'warning', message: 'the screen is locked: nothing is captured until it is unlocked' });
    started();
    return;
  }
  if (mode === 'writer-fails') {
    process.on('SIGINT', () => {});  // the writer is already failing; it exits 6 on its own
    started();
    setTimeout(() => { print({ event: 'stopped', reason: 'writer-failed', frames: 3 }); process.exit(6); }, 300);
    return;
  }
  const out = flag('out');
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '60',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mov', out], { stdio: ['pipe', 'ignore', 'ignore'] });
  let stopping = false;
  // lavfi runs faster than real time, so on a fast machine ffmpeg can finish its 60 s before stop: report it anyway.
  const stop = (reason) => {
    if (stopping) return; stopping = true;
    const done = () => { print({ event: 'stopped', reason, frames: 1 }); process.exit(0); };
    if (ff.exitCode !== null || ff.signalCode !== null) return done();
    ff.on('exit', done); ff.stdin.write('q');
  };
  process.on('SIGINT', () => stop('signal'));
  // "started" once the first fragment is on disk, so a stop right after start still has frames to save
  const hasFragment = () => { try { return fs.readFileSync(out).includes('moof'); } catch { return false; } };
  const wait = setInterval(() => {
    if (!hasFragment()) return;
    clearInterval(wait);
    const startedAt = started();
    if (mode === 'late-first-frame') setTimeout(() => print({ event: 'first-frame' }), 1500);
    else if (mode === 'first-frame-ms') setTimeout(() => print({ event: 'first-frame', ms: startedAt + 500 }), 1500);
    else print({ event: 'first-frame' });
    if (mode === 'target-closes') setTimeout(() => stop('target-closed'), 1500);
  }, 20);
}

if (mode === 'hang') setInterval(() => {}, 1000);  // never answers
else if (mode === 'locked') { print(locked); process.exit(1); }
else if (mode === 'no-permission') { print({ ok: false, code: 'E_PERMISSION', message: 'not granted' }); process.exit(1); }
else if (cmd === 'displays') print({ ok: true, displays: [{ id: 1, name: 'Built-in', x: 0, y: 0, width: 1440, height: 900, scale: 2, main: true }] });
else if (cmd === 'windows') print({ ok: true, windows: [
  { id: 7, app: 'Finder', title: 'Downloads', x: 10, y: 10, width: 801, height: 501, onScreen: true, z: 0, pid: 99 },
  { id: 8, app: 'Google Chrome', title: 'Agent Docs', x: 100, y: 100, width: 800, height: 500, onScreen: true, z: 1, pid: 98 }] });
else if (cmd === 'permission') print({ ok: true, granted: true });
else if (cmd === 'screenshot') {
  const out = flag('out');
  if (mode === 'bad-png') fs.writeFileSync(out, 'not a png');
  else execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', out]);
  print({ ok: true, out, width: 320, height: 240 });
}
else if (cmd === 'record') { if (mode === 'slow-start') setTimeout(record, 1200); else record(); }
else print({ ok: false, code: 'E_BAD_ARGS', message: `fake: ${cmd}` });
