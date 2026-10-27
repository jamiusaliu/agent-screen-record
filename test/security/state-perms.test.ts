// The state folder holds the recording state (window titles, tab patterns, output paths) and the
// broker's token file. On macOS other local accounts can usually list a home folder, so the folder is
// created 0700 and the state file written 0600, whoever creates the folder first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { writeState, statePath, stateDir, type RecordingState } from '../../src/core/state.ts';

const STATE: RecordingState = {
  pid: 1, worker: 'cdp', target: { kind: 'tab', mode: 'title', pattern: 'Bank statement' }, raw: '/r.mkv', out: '/r.mp4',
  marksFile: '/r.marks.jsonl', meta: true, startedAt: 0, maxMs: 1000, label: 'Chrome tab (title: Bank statement)',
};

test('the state folder is created 0700 and state.json is written 0600', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'srperm-'));
  const prev = process.env.SCREENREC_HOME;
  process.env.SCREENREC_HOME = path.join(base, 'nested', 'home');
  const umask = process.umask(0o022);
  try {
    writeState(STATE);
    assert.equal(fs.statSync(stateDir()).mode & 0o777, 0o700);
    assert.equal(fs.statSync(statePath()).mode & 0o777, 0o600);
    writeState({ ...STATE, pid: 2 });  // a rewrite keeps 0600
    assert.equal(fs.statSync(statePath()).mode & 0o777, 0o600);
  } finally {
    process.umask(umask);
    if (prev === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
