import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { recordingsDir, defaultRecordingBase, derivedOut, stripExt } from '../../src/core/paths.ts';

test('recordingsDir creates the folder with a catch-all .gitignore', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  const d = recordingsDir(cwd);
  assert.equal(d, path.join(cwd, 'recordings'));
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8').trim(), '*');
});

test('defaultRecordingBase is sortable local time', () => {
  assert.equal(defaultRecordingBase(new Date(2026, 9, 17, 9, 5, 7)), 'rec-20261017-090507');
});

test('derivedOut never overwrites and keeps unicode and spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-'));
  const input = path.join(dir, 'My Video é.mp4');
  assert.equal(derivedOut(input, 'squeeze', 'mp4'), path.join(dir, 'My Video é.squeeze.mp4'));
  fs.writeFileSync(path.join(dir, 'My Video é.squeeze.mp4'), '');
  assert.equal(derivedOut(input, 'squeeze', 'mp4'), path.join(dir, 'My Video é.squeeze-2.mp4'));
  assert.equal(stripExt('/a/b.c/d.mp4'), '/a/b.c/d');
});

/** A temp folder the test may write to but nothing else can: chmod 555 after creating it. */
function unwritable(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
  fs.chmodSync(d, 0o555);
  return d;
}
const cleanup = (...ds: string[]) => { for (const d of ds) { fs.chmodSync(d, 0o755); fs.rmSync(d, { recursive: true, force: true }); } };

test('recordingsDir: a cwd of / uses ~/Movies/screenrec, created without a .gitignore', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  try {
    const d = recordingsDir('/', home);
    assert.equal(d, path.join(home, 'Movies', 'screenrec'));
    assert.ok(fs.statSync(d).isDirectory());
    assert.ok(!fs.existsSync(path.join(d, '.gitignore')), 'not a working tree: no stray dotfile in Movies');
    assert.equal(fs.statSync(d).mode & 0o777, 0o700, 'recordings and sidecars hold window titles and URLs: private to the user');
    assert.ok(!fs.existsSync('/recordings'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordingsDir: an unwritable cwd uses ~/Movies/screenrec; a writable one keeps <cwd>/recordings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const ro = unwritable();
  const rw = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
  try {
    assert.equal(recordingsDir(ro, home), path.join(home, 'Movies', 'screenrec'));
    assert.deepEqual(fs.readdirSync(ro), [], 'nothing written into the unwritable cwd');
    const home2 = path.join(rw, 'home');
    assert.equal(recordingsDir(rw, home2), path.join(rw, 'recordings'));
    assert.ok(!fs.existsSync(home2), 'a normal cwd never touches ~/Movies');
  } finally { cleanup(ro); fs.rmSync(rw, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordingsDir: a cwd that no longer exists uses ~/Movies/screenrec', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  try { assert.equal(recordingsDir(path.join(home, 'gone'), home), path.join(home, 'Movies', 'screenrec')); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('derivedOut: next to the input in a writable folder, else the default folder with the same name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const rw = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
  fs.writeFileSync(path.join(ro, 'clip.mp4'), 'x'); fs.chmodSync(ro, 0o555);
  try {
    fs.writeFileSync(path.join(rw, 'clip.mp4'), 'x');
    assert.equal(derivedOut(path.join(rw, 'clip.mp4'), 'trim', 'mp4', { cwd: rw, home }), path.join(rw, 'clip.trim.mp4'));
    assert.equal(derivedOut(path.join(ro, 'clip.mp4'), 'trim', 'mp4', { cwd: rw, home }), path.join(rw, 'recordings', 'clip.trim.mp4'));
    assert.equal(derivedOut(path.join(ro, 'clip.mp4'), 'trim', 'mp4', { cwd: '/', home }), path.join(home, 'Movies', 'screenrec', 'clip.trim.mp4'));
    fs.writeFileSync(path.join(rw, 'recordings', 'clip.trim.mp4'), 'taken');
    assert.equal(derivedOut(path.join(ro, 'clip.mp4'), 'trim', 'mp4', { cwd: rw, home }), path.join(rw, 'recordings', 'clip.trim-2.mp4'));
    assert.equal(derivedOut(path.join(home, 'no-dir', 'a.mp4'), 'gif', 'gif', { cwd: rw, home }), path.join(home, 'no-dir', 'a.gif.gif'),
      'a missing input folder is left to the input check');
  } finally { cleanup(ro); fs.rmSync(rw, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordingsDir creates ./recordings readable only by the owner, and leaves an existing folder as it is', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  try {
    const d = recordingsDir(cwd);
    assert.equal(fs.statSync(d).mode & 0o777, 0o700);
    fs.chmodSync(d, 0o755);
    recordingsDir(cwd);
    assert.equal(fs.statSync(d).mode & 0o777, 0o755, 'a folder the user set up is not changed');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
