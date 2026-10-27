import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { squeeze } from '../../src/edit/squeeze.ts';
import { crop } from '../../src/edit/crop.ts';
import { trim } from '../../src/edit/trim.ts';
import { frame } from '../../src/edit/frame.ts';
import { blur } from '../../src/edit/blur.ts';
import { gif } from '../../src/edit/gif.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import { assertOutFree, assertOutFolder, OUT_EXISTS_FIX, writeOut, publish } from '../../src/edit/output.ts';

const badArgs = (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && /different --out/.test(e.fix);

/** Real aliases of `input`: a symlink, a hard link and (on a case-insensitive volume) a case variant. */
function aliases(dir: string, input: string): { kind: string; p: string }[] {
  const link = path.join(dir, 'link.mp4'); fs.symlinkSync(input, link);
  const hard = path.join(dir, 'hard.mp4'); fs.linkSync(input, hard);
  const out = [{ kind: 'symlink', p: link }, { kind: 'hard link', p: hard }];
  const upper = path.join(dir, path.basename(input).toUpperCase());
  if (fs.existsSync(upper)) out.push({ kind: 'case variant', p: upper });
  return out;
}
const caseInsensitive = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'og-case-'));
  try { fs.writeFileSync(path.join(d, 'probe'), ''); return fs.existsSync(path.join(d, 'PROBE')); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

async function refusesAll(input: string, out: string, force: boolean, label: string) {
  await assert.rejects(squeeze(input, { out, force }), badArgs, `squeeze ${label}`);
  await assert.rejects(crop(input, { trimEdges: 2, out, force }), badArgs, `crop ${label}`);
  await assert.rejects(trim(input, { from: 0, to: 1, out, force }), badArgs, `trim ${label}`);
  await assert.rejects(frame(input, { at: 0, out, force }), badArgs, `frame ${label}`);
  await assert.rejects(blur(input, { boxes: [{ x: 0, y: 0, w: 8, h: 8 }], out, force }), badArgs, `blur ${label}`);
  await assert.rejects(gif(input, { out, force }), badArgs, `gif ${label}`);
}

test('every edit command refuses an --out that is the input or a real alias of it, leaving it untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  try {
    const input = path.join(dir, 'in.mp4');
    fs.writeFileSync(input, 'precious');
    await refusesAll(input, path.join(dir, '.', 'in.mp4'), false, './');
    const al = aliases(dir, input);
    assert.equal(al.length, caseInsensitive ? 3 : 2);
    for (const a of al) await refusesAll(input, a.p, false, a.kind);
    assert.equal(fs.readFileSync(input, 'utf8'), 'precious');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('squeeze and trim refuse an --out whose sidecar would be the input sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  try {
    const input = path.join(dir, 'in.mp4');
    fs.writeFileSync(input, 'x');
    const other = path.join(dir, 'in.mkv');
    await assert.rejects(squeeze(input, { out: other }), badArgs);
    await assert.rejects(trim(input, { from: 0, to: 1, out: other }), badArgs);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// An explicit --out never silently replaces an existing file; --force allows it, but never onto the input.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const exists = (p: string) => (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && e.message.includes(p) && e.fix === OUT_EXISTS_FIX;

test('OUT_EXISTS_FIX names --out, --force and the default name', () => {
  assert.ok(OUT_EXISTS_FIX.startsWith('Choose a different --out path, add --force to replace it, or omit --out to get a new name.'));
  assert.match(OUT_EXISTS_FIX, /force: true/, 'MCP callers learn the input name too');
});

test('assertOutFree: a free path passes; an existing file is refused by path unless force', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'my clip é.mp4');
    assertOutFree(out);
    fs.writeFileSync(out, 'mine');
    assert.throws(() => assertOutFree(out), exists(out));
    assert.throws(() => assertOutFree(out, { force: false }), exists(out));
    assertOutFree(out, { force: true });
    assert.equal(fs.readFileSync(out, 'utf8'), 'mine', 'the check never touches the file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertOutFree: with sidecar, an existing <out>.json is refused too', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'a.mp4'); const side = path.join(dir, 'a.json');
    fs.writeFileSync(side, '{}');
    assertOutFree(out);
    assert.throws(() => assertOutFree(out, { sidecar: true }), exists(side));
    assertOutFree(out, { sidecar: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertOutFree: a dangling symlink counts as existing; a directory is refused even with force', () => {
  const dir = tmp();
  try {
    const link = path.join(dir, 'link.mp4');
    fs.symlinkSync(path.join(dir, 'nowhere.mp4'), link);
    assert.throws(() => assertOutFree(link), exists(link));
    const d = path.join(dir, 'folder.mp4'); fs.mkdirSync(d);
    assert.throws(() => assertOutFree(d, { force: true }), (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && /directory/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every edit command refuses an existing explicit --out and leaves both files untouched', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    const taken = path.join(dir, 'taken.mp4'); fs.writeFileSync(taken, 'mine');
    const png = path.join(dir, 'taken.png'); fs.writeFileSync(png, 'mine');
    const gifOut = path.join(dir, 'taken.gif'); fs.writeFileSync(gifOut, 'mine');
    await assert.rejects(squeeze(input, { out: taken }), exists(taken));
    await assert.rejects(crop(input, { trimEdges: 2, out: taken }), exists(taken));
    await assert.rejects(trim(input, { from: 0, to: 1, out: taken }), exists(taken));
    await assert.rejects(frame(input, { at: 0, out: png }), exists(png));
    await assert.rejects(blur(input, { boxes: [{ x: 0, y: 0, w: 8, h: 8 }], out: taken }), exists(taken));
    await assert.rejects(gif(input, { out: gifOut }), exists(gifOut));
    for (const f of [taken, png, gifOut]) assert.equal(fs.readFileSync(f, 'utf8'), 'mine');
    assert.equal(fs.readFileSync(input, 'utf8'), 'precious');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('squeeze and trim refuse an explicit --out whose sidecar exists, when they would write one', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify({ version: 1, target: { kind: 'display', display: 'main' }, startedAt: 'x', durationSec: 1, marks: [] }));
    const out = path.join(dir, 'new.mp4'); const side = path.join(dir, 'new.json');
    fs.writeFileSync(side, 'mine');
    await assert.rejects(squeeze(input, { out }), exists(side));
    await assert.rejects(trim(input, { from: 0, to: 1, out }), exists(side));
    assert.equal(fs.readFileSync(side, 'utf8'), 'mine');
    // No input sidecar: nothing is written next to --out, so an unrelated new.json is not in the way.
    fs.rmSync(path.join(dir, 'in.json'));
    await assert.rejects(trim(input, { from: 0, to: 1, out }), (e: unknown) => e instanceof ScreenrecError && e.code !== 'E_BAD_ARGS');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('force never allows --out to be the input or a symlink or hard link of it', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    await refusesAll(input, path.join(dir, '.', 'in.mp4'), true, './');
    for (const a of aliases(dir, input).filter((x) => x.kind !== 'case variant')) await refusesAll(input, a.p, true, a.kind);
    await assert.rejects(squeeze(input, { out: path.join(dir, 'in.mkv'), force: true }), badArgs);
    await assert.rejects(trim(input, { from: 0, to: 1, out: path.join(dir, 'in.mkv'), force: true }), badArgs);
    assert.equal(fs.readFileSync(input, 'utf8'), 'precious');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('force never allows a case variant of the input on a case-insensitive volume', { skip: caseInsensitive ? false : 'the temp volume is case-sensitive, so a case variant is a different file' }, async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    await refusesAll(input, path.join(dir, 'IN.mp4'), true, 'case variant');
    assert.equal(fs.readFileSync(input, 'utf8'), 'precious');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('force never allows an --out whose sidecar is an alias of the input sidecar', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    const side = path.join(dir, 'in.json'); fs.writeFileSync(side, '{"version":1,"marks":[]}');
    fs.symlinkSync(side, path.join(dir, 'sym.json')); fs.linkSync(side, path.join(dir, 'hard.json'));
    const outs = [path.join(dir, 'sym.mp4'), path.join(dir, 'hard.mp4'), ...(caseInsensitive ? [path.join(dir, 'IN.mkv')] : [])];
    for (const out of outs) {
      await assert.rejects(squeeze(input, { out, force: true }), badArgs, out);
      await assert.rejects(trim(input, { from: 0, to: 1, out, force: true }), badArgs, out);
    }
    assert.equal(fs.readFileSync(side, 'utf8'), '{"version":1,"marks":[]}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--force without --out is refused on every edit command', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    const noOut = (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && e.fix === '--force only applies with --out.';
    await assert.rejects(squeeze(input, { force: true }), noOut);
    await assert.rejects(crop(input, { trimEdges: 2, force: true }), noOut);
    await assert.rejects(trim(input, { from: 0, to: 1, force: true }), noOut);
    await assert.rejects(frame(input, { at: 0, force: true }), noOut);
    await assert.rejects(blur(input, { boxes: [{ x: 0, y: 0, w: 8, h: 8 }], force: true }), noOut);
    await assert.rejects(gif(input, { force: true }), noOut);
    assert.deepEqual(fs.readdirSync(dir), ['in.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut: success moves the temp file into place; a failure leaves the original and no temp file', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'clip.mp4'); fs.writeFileSync(out, 'original');
    let seen = '';
    await assert.rejects(writeOut(out, { force: true, explicit: true }, async (t) => { seen = t; fs.writeFileSync(t, 'half'); throw new Error('ffmpeg died'); }), /ffmpeg died/);
    assert.equal(path.dirname(seen), dir); assert.equal(path.extname(seen), '.mp4', 'ffmpeg infers the format from the extension');
    assert.ok(path.basename(seen).startsWith('.clip.'));
    assert.equal(fs.readFileSync(out, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['clip.mp4'], 'temp file removed');
    const r = await writeOut(out, { force: true, explicit: true }, async (t) => { fs.writeFileSync(t, 'new'); return 7; });
    assert.equal(r.value, 7); assert.equal(r.out, out); assert.equal(fs.readFileSync(out, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ['clip.mp4']);
    const fresh = path.join(dir, 'fresh.mp4');
    await writeOut(fresh, {}, async (t) => { fs.writeFileSync(t, 'x'); });
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut without force refuses a file that appeared after the check, atomically', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'race.mp4');
    assertOutFree(out);
    await assert.rejects(writeOut(out, { explicit: true }, async (t) => {
      fs.writeFileSync(t, 'ours');
      fs.writeFileSync(out, 'someone else');  // appears between the check and the publish
    }), exists(out));
    assert.equal(fs.readFileSync(out, 'utf8'), 'someone else');
    assert.deepEqual(fs.readdirSync(dir), ['race.mp4'], 'temp file removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut with force refuses a directory that appeared at the output path', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'd.mp4');
    await assert.rejects(writeOut(out, { force: true, explicit: true }, async (t) => { fs.writeFileSync(t, 'x'); fs.mkdirSync(out); }),
      (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && /directory/.test(e.message));
    assert.deepEqual(fs.readdirSync(dir), ['d.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const sc = (note: string) => ({ version: 1 as const, target: { kind: 'display' as const, display: 'main' }, startedAt: 'x', durationSec: 1, marks: [{ t: 0, text: note }] });

test('writeOut with a default name takes the next free name instead of failing', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'in.trim.mp4');
    fs.writeFileSync(out, 'first');
    const r = await writeOut(out, {}, async (t) => { fs.writeFileSync(t, 'second'); });
    assert.equal(r.out, path.join(dir, 'in.trim-2.mp4'));
    // a name whose sidecar is taken is skipped too, so the pair always matches
    fs.writeFileSync(path.join(dir, 'in.trim-3.json'), 'other notes');
    const s = await writeOut(out, { sidecar: () => sc('third') }, async (t) => { fs.writeFileSync(t, 'third'); });
    assert.equal(s.out, path.join(dir, 'in.trim-4.mp4')); assert.equal(s.sidecar, path.join(dir, 'in.trim-4.json'));
    assert.equal(fs.readFileSync(out, 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(dir, 'in.trim-3.json'), 'utf8'), 'other notes');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut publishes the sidecar after the video: a failed video publish leaves the old pair intact', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'clip.mp4'); const side = path.join(dir, 'clip.json');
    fs.writeFileSync(side, 'old notes');
    // a folder appears at out after the encode: the forced video publish fails
    await assert.rejects(writeOut(out, { force: true, explicit: true, sidecar: () => sc('new') }, async (t) => { fs.writeFileSync(t, 'v'); fs.mkdirSync(out); }),
      (e: unknown) => e instanceof ScreenrecError && /directory/.test(e.message));
    assert.equal(fs.readFileSync(side, 'utf8'), 'old notes');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['clip.json', 'clip.mp4']);
    fs.rmdirSync(out); fs.writeFileSync(out, 'old video');
    const r = await writeOut(out, { force: true, explicit: true, sidecar: () => sc('new') }, async (t) => { fs.writeFileSync(t, 'new video'); });
    assert.equal(r.sidecar, side); assert.equal(fs.readFileSync(out, 'utf8'), 'new video');
    assert.equal(JSON.parse(fs.readFileSync(side, 'utf8')).marks[0].text, 'new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut errors name the real output path, not the deleted temp file', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'x.mp4');
    let t0 = '';
    await assert.rejects(writeOut(out, {}, async (t) => { t0 = t; throw new ScreenrecError('E_FFMPEG_FAILED', `Could not read video info from ${t}`, 'fix'); }),
      (e: unknown) => e instanceof ScreenrecError && e.code === 'E_FFMPEG_FAILED' && e.message.includes(out) && !e.message.includes(t0));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publish: a failed exclusive copy (no hard links on the volume) removes its partial file at the real name', () => {
  const dir = tmp();
  try {
    const t = path.join(dir, '.o.tmp.mp4'); fs.writeFileSync(t, 'full content');
    const out = path.join(dir, 'o.mp4');
    const errno = (code: string) => Object.assign(new Error(code), { code });
    assert.throws(() => publish(t, out, {}, {
      link: () => { throw errno('EPERM'); },
      copy: (_a: string, b: string) => { fs.writeFileSync(b, 'full'); throw errno('ENOSPC'); },
    }), /ENOSPC/);
    assert.ok(!fs.existsSync(out), 'partial output removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const missingFolder = (dir: string) => (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' &&
  e.message === `folder does not exist: ${dir}` && e.fix === 'Create the folder first or choose another --out.';

test('assertOutFolder: an existing folder passes; a missing one or a file in its place is refused by name', () => {
  const dir = tmp();
  try {
    assertOutFolder(path.join(dir, 'a.mp4'));
    const missing = path.join(dir, 'no such', 'deeper');
    assert.throws(() => assertOutFolder(path.join(missing, 'a.mp4')), missingFolder(missing));
    const file = path.join(dir, 'plain'); fs.writeFileSync(file, '');
    assert.throws(() => assertOutFolder(path.join(file, 'a.mp4')), (e: unknown) => e instanceof ScreenrecError &&
      e.code === 'E_BAD_ARGS' && e.message === `not a folder: ${file}` && /choose another --out/.test(e.fix));
    assert.throws(() => assertOutFolder(path.join(file, 'sub', 'a.mp4')), (e: unknown) => e instanceof ScreenrecError &&
      e.message === `not a folder: ${file}`, 'a file further up is named too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeOut refuses a missing output folder before running the write, explicit or not', async () => {
  const dir = tmp();
  try {
    const missing = path.join(dir, 'gone');
    for (const explicit of [true, false]) {
      let ran = false;
      await assert.rejects(writeOut(path.join(missing, 'a.png'), { explicit }, async () => { ran = true; }), missingFolder(missing));
      assert.equal(ran, false, 'the expensive write never starts');
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every edit command names a missing --out folder instead of failing inside ffmpeg', async () => {
  const dir = tmp();
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'not really a video');
    const missing = path.join(dir, 'no-such-dir');
    const is = missingFolder(missing);
    await assert.rejects(squeeze(input, { out: path.join(missing, 'a.mp4') }), is, 'squeeze');
    await assert.rejects(crop(input, { trimEdges: 2, out: path.join(missing, 'a.mp4') }), is, 'crop');
    await assert.rejects(trim(input, { from: 0, to: 1, out: path.join(missing, 'a.mp4') }), is, 'trim');
    await assert.rejects(frame(input, { at: 0, out: path.join(missing, 'a.png') }), is, 'frame');
    await assert.rejects(blur(input, { boxes: [{ x: 0, y: 0, w: 8, h: 8 }], out: path.join(missing, 'a.mp4') }), is, 'blur');
    await assert.rejects(gif(input, { out: path.join(missing, 'a.gif') }), is, 'gif');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertOutFolder: an unreadable parent, a symlink loop or an unwritable folder is E_BAD_ARGS naming the folder', () => {
  const dir = tmp();
  try {
    const shut = path.join(dir, 'shut'); fs.mkdirSync(path.join(shut, 'inner'), { recursive: true }); fs.chmodSync(shut, 0o000);
    const isBad = (re: RegExp) => (e: unknown) => e instanceof ScreenrecError && e.code === 'E_BAD_ARGS' && re.test(e.message) && /choose another --out/.test(e.fix);
    assert.throws(() => assertOutFolder(path.join(shut, 'inner', 'a.mp4')), isBad(new RegExp(`^cannot use folder: ${path.join(shut, 'inner')} \\(permission denied\\)$`)));
    fs.chmodSync(shut, 0o755);
    const loop = path.join(dir, 'loop'); fs.symlinkSync(loop, loop);
    assert.throws(() => assertOutFolder(path.join(loop, 'a.mp4')), isBad(new RegExp(`^cannot use folder: ${loop} \\(symbolic link loop\\)$`)));
    const ro = path.join(dir, 'ro'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o555);
    assert.throws(() => assertOutFolder(path.join(ro, 'a.mp4')), isBad(new RegExp(`^folder is not writable: ${ro}$`)));
    fs.chmodSync(ro, 0o755);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publish: a copy that fails before creating anything never deletes a file already at out', () => {
  const dir = tmp();
  try {
    const t = path.join(dir, '.o.tmp.mp4');  // missing: the copy fails reading it (ENOENT), before writing out
    const out = path.join(dir, 'o.mp4'); fs.writeFileSync(out, 'user file');
    const errno = (code: string) => Object.assign(new Error(code), { code });
    assert.throws(() => publish(t, out, {}, {
      link: () => { throw errno('EXDEV'); },
      copy: (a: string, b: string) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL),
      rename: (a: string, b: string) => fs.renameSync(a, b),
    }));
    assert.equal(fs.readFileSync(out, 'utf8'), 'user file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
