import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readState, writeState, clearState, statePath, isRecorderAlive, type RecordingState } from '../../src/core/state.ts';

beforeEach(() => { process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-')); });

const s: RecordingState = { pid: 123, worker: 'mac', target: { kind: 'display', display: 'main' }, raw: '/tmp/a.mov',
  out: '/tmp/a.mp4', marksFile: '/tmp/a.marks.jsonl', meta: true, startedAt: 1000, maxMs: 600000 };

test('state round-trips and clears', () => {
  assert.equal(readState(), null);
  writeState(s);
  assert.deepEqual(readState(), s);
  assert.ok(statePath().startsWith(process.env.SCREENREC_HOME!));
  clearState();
  assert.equal(readState(), null);
});

test('corrupt state file reads as null rather than throwing', () => {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{not json');
  assert.equal(readState(), null);
});

test('liveness requires a screenrec command line, not just a live pid (pid reuse)', () => {
  assert.equal(isRecorderAlive(42, () => '/usr/bin/screenrec-mac record --window-id 3'), true);
  assert.equal(isRecorderAlive(42, () => 'node /x/dist/capture/cdp/worker.js'), true);
  assert.equal(isRecorderAlive(42, () => 'vim /home/me/screenrec/notes.md'), false); // name alone is not enough
  assert.equal(isRecorderAlive(42, () => '/Applications/Safari.app/Contents/MacOS/Safari'), false);
  assert.equal(isRecorderAlive(42, () => null), false);
  assert.equal(isRecorderAlive(process.pid), false); // the test runner is not a recorder
});

test('on win32 (no ps) recorder liveness falls back to the pid, so status never recovers a live worker', () => {
  assert.equal(isRecorderAlive(process.pid, () => null, 'win32'), true);
  assert.equal(isRecorderAlive(2 ** 30, () => null, 'win32'), false);
});
