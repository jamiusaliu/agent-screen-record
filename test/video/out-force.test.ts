import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { main } from '../../src/cli/main.ts';
import { probe } from '../../src/edit/ffmpeg.ts';
import { writeSidecar, readSidecar } from '../../src/core/sidecar.ts';

const run = async (argv: string[]) => {
  const out: string[] = [];
  const code = await main([...argv, '--json'], { out: (s) => out.push(s), err: () => {} });
  return { code, j: JSON.parse(out.join('')) };
};

test('trim: an existing --out keeps its bytes without --force and is replaced with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving', { seconds: 4 });
    const out = path.join(dir, 'keep me.mp4'); fs.writeFileSync(out, 'original bytes');
    const refused = await run(['trim', input, '--from', '1', '--to', '3', '--out', out]);
    assert.equal(refused.code, 1); assert.equal(refused.j.code, 'E_BAD_ARGS'); assert.ok(refused.j.message.includes(out));
    assert.equal(fs.readFileSync(out, 'utf8'), 'original bytes');
    const forced = await run(['trim', input, '--from', '1', '--to', '3', '--out', out, '--force']);
    assert.equal(forced.code, 0, JSON.stringify(forced.j)); assert.equal(forced.j.out, out);
    const d = (await probe(out)).duration;
    assert.ok(d > 1.8 && d < 2.2, `replaced with a 2 s video, got ${d}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('squeeze: an existing sidecar next to --out follows the same rule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving-frozen-moving');
    writeSidecar(path.join(dir, 'in.json'), { version: 1, target: { kind: 'display', display: 'main' }, startedAt: '2026-10-17T00:00:00Z', durationSec: 8,
      marks: [{ t: 7, text: 'late' }] });
    const out = path.join(dir, 'short.mp4'); const side = path.join(dir, 'short.json');
    fs.writeFileSync(side, 'my notes');
    const refused = await run(['squeeze', input, '--out', out]);
    assert.equal(refused.code, 1); assert.ok(refused.j.message.includes(side));
    assert.equal(fs.readFileSync(side, 'utf8'), 'my notes'); assert.ok(!fs.existsSync(out), 'nothing written');
    const forced = await run(['squeeze', input, '--out', out, '--force']);
    assert.equal(forced.code, 0, JSON.stringify(forced.j));
    assert.ok(fs.existsSync(out)); assert.equal(readSidecar(side)!.marks[0].text, 'late');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a forced trim that fails (past the end) leaves the file it was asked to replace byte for byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving', { seconds: 2 });
    const out = path.join(dir, 'old.mp4'); await makeVideo(out, 'moving', { seconds: 1 });
    const before = fs.readFileSync(out);
    const r = await run(['trim', input, '--from', '50', '--to', '60', '--out', out, '--force']);
    assert.equal(r.code, 1, JSON.stringify(r.j));
    assert.ok(fs.readFileSync(out).equals(before), 'original bytes kept');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['in.mp4', 'old.mp4'], 'no temp file left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a forced crop replaces the file and leaves no temp file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving', { seconds: 1 });
    const out = path.join(dir, 'c.mp4'); fs.writeFileSync(out, 'old');
    const r = await run(['crop', input, '--trim-edges', '8', '--out', out, '--force']);
    assert.equal(r.code, 0, JSON.stringify(r.j)); assert.equal(r.j.out, out);
    assert.equal((await probe(out)).width, 304);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['c.mp4', 'in.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two parallel default trims both succeed, each with its own file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving', { seconds: 3 });
    const [a, b] = await Promise.all([run(['trim', input, '--to', '2']), run(['trim', input, '--to', '2'])]);
    assert.equal(a.code, 0, JSON.stringify(a.j)); assert.equal(b.code, 0, JSON.stringify(b.j));
    assert.notEqual(a.j.out, b.j.out);
    assert.deepEqual([a.j.out, b.j.out].map((f: string) => path.basename(f)).sort(), ['in.trim-2.mp4', 'in.trim.mp4']);
    for (const f of [a.j.out, b.j.out]) assert.ok((await probe(f)).duration > 1.5, f);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two default screenshots in the same second both succeed with distinct files', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const prev = process.cwd(); const prevHelper = process.env.SCREENREC_MAC_HELPER;
  process.env.SCREENREC_MAC_HELPER = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
  process.chdir(dir);
  try {
    const { defaultRecordingBase } = await import('../../src/core/paths.ts');
    // Take this second's and the next second's default names, so both runs must step to a free name.
    const rec = path.join(dir, 'recordings'); fs.mkdirSync(rec);
    const now = Date.now();
    const taken = [now, now + 1000].map((t) => path.join(rec, `${defaultRecordingBase(new Date(t))}.png`));
    for (const f of taken) fs.writeFileSync(f, 'mine');
    const [a, b] = await Promise.all([run(['screenshot', '--window', 'Finder']), run(['screenshot', '--window', 'Finder'])]);
    assert.equal(a.code, 0, JSON.stringify(a.j)); assert.equal(b.code, 0, JSON.stringify(b.j));
    assert.notEqual(a.j.out, b.j.out);
    for (const f of [a.j.out, b.j.out]) { assert.match(path.basename(f), /^rec-\d{8}-\d{6}-\d+\.png$/); assert.equal((await probe(f)).width, 320); }
    for (const f of taken) assert.equal(fs.readFileSync(f, 'utf8'), 'mine');
  } finally {
    process.chdir(prev);
    if (prevHelper === undefined) delete process.env.SCREENREC_MAC_HELPER; else process.env.SCREENREC_MAC_HELPER = prevHelper;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGINT during a forced encode removes the temp file, stops ffmpeg and keeps the old file', async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  try {
    const input = path.join(dir, 'big.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=20,noise=alls=60:allf=t+u',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', input]);
    const out = path.join(dir, 'old.mp4'); fs.writeFileSync(out, 'original bytes');
    const mainUrl = new URL('../../src/cli/main.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '-e',
      `import(${JSON.stringify(mainUrl)}).then(async (m) => process.exit(await m.main(process.argv.slice(1))))`,
      'crop', input, '--trim-edges', '8', '--out', out, '--force', '--json'], { stdio: 'ignore' });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    const temps = () => fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    for (const end = Date.now() + 30_000; temps().length === 0 && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    const [tmpName] = temps(); assert.ok(tmpName, 'the encode started');
    child.kill('SIGINT');
    await exited;
    assert.deepEqual(temps(), [], 'temp file removed');
    assert.equal(fs.readFileSync(out, 'utf8'), 'original bytes');
    await new Promise((r) => setTimeout(r, 300));
    const ps = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    assert.ok(!ps.includes(tmpName), 'no ffmpeg left writing the temp file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every clean-up command names a missing --out folder (not an ffmpeg failure) and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  try {
    const input = path.join(dir, 'in.mp4'); await makeVideo(input, 'moving', { seconds: 2 });
    const missing = path.join(dir, 'no-such-dir');
    const cases: [string, string[]][] = [
      ['a.mp4', ['squeeze', input]], ['a.mp4', ['trim', input, '--from', '0', '--to', '1']],
      ['a.mp4', ['crop', input, '--trim-edges', '2']], ['a.png', ['frame', input, '--at', '0.5']],
      ['a.mp4', ['blur', input, '--box', '0,0,8,8']], ['a.gif', ['gif', input]],
    ];
    for (const [name, argv] of cases) {
      const r = await run([...argv, '--out', path.join(missing, name)]);
      assert.equal(r.code, 1, argv[0]);
      assert.deepEqual([r.j.code, r.j.message, r.j.fix],
        ['E_BAD_ARGS', `folder does not exist: ${missing}`, 'Create the folder first or choose another --out.'], `${argv[0]}: ${JSON.stringify(r.j)}`);
    }
    assert.deepEqual(fs.readdirSync(dir), ['in.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
