import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { launchChrome } from './launch.ts';
import { CdpClient } from '../../src/capture/cdp/client.ts';
import { readMarks } from '../../src/core/sidecar.ts';
import { waitForPaints, centreColours } from './paint.ts';
const exec = promisify(execFile);

const page = (palette: 'colour' | 'grey') => new URL('../fixtures/colour-page.html', import.meta.url).href + (palette === 'grey' ? '?grey' : '');
const workerTs = new URL('../../src/capture/cdp/worker.ts', import.meta.url).pathname;
const chrome = await launchChrome();
after(() => chrome.proc.kill());


const tmpDirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); });

function startWorker(cfg: object) {
  const p = spawn(process.execPath, ['--import', 'tsx', workerTs], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += String(d); });
  const ready = new Promise<void>((r) => p.stdout.on('data', (d) => { if (String(d).includes('ready')) r(); }));
  // a hung worker fails the test (exit -999) instead of hanging the run
  const done = new Promise<number>((r) => {
    const t = setTimeout(() => { console.error('HUNG stderr:', stderr); p.kill('SIGKILL'); r(-999); }, 180000);
    p.on('exit', (c) => { clearTimeout(t); r(c ?? -1); });
    t.unref;
  });
  p.stdin.on('error', () => {});
  p.stdin.write(JSON.stringify(cfg) + '\n');  // config on stdin, as the recorder sends it
  return { stop: () => p.stdin.write('stop\n'), done, ready, stderr: () => stderr };
}

async function duration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

test('records a hidden background tab opened after start (newest), live colours', async () => {
  const dir = tmp('tab-');
  const out = path.join(dir, 'tab.mkv'); const marksFile = path.join(dir, 'm.jsonl');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 150, marksFile, t0Ms: Date.now() });
  await w.ready;
  const c = await CdpClient.connect(chrome.wsUrl);
  const { targetId } = await c.send('Target.createTarget', { url: page('colour'), background: true });
  await waitForPaints(c, targetId, 6);
  w.stop();
  assert.equal(await w.done, 0);
  const colours = await centreColours(out);
  assert.ok(colours.size >= 4, `distinct colours ${colours.size}`);
  c.close();
});

test('follow: switches to a second agent tab, notes the switch, survives the first closing', async () => {
  const dir = tmp('fol-');
  const out = path.join(dir, 'f.mkv'); const marksFile = path.join(dir, 'm.jsonl');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'follow', out, fps: 30, maxSeconds: 150, marksFile, t0Ms: Date.now() });
  await w.ready;
  const c = await CdpClient.connect(chrome.wsUrl);
  const a = await c.send('Target.createTarget', { url: page('colour'), background: true });
  await waitForPaints(c, a.targetId, 4);
  const g = await c.send('Target.createTarget', { url: page('grey'), background: true });
  await c.send('Target.closeTarget', { targetId: a.targetId });
  await waitForPaints(c, g.targetId, 4);
  w.stop();
  assert.equal(await w.done, 0);
  const marks = readMarks(marksFile);
  assert.ok(marks.filter((m) => m.text.startsWith('switched to tab')).length >= 2, JSON.stringify(marks));
  assert.ok(!marks.some((m) => m.text.startsWith('switched to tab') && m.text.includes('about:blank')), 'never records the pre-existing tab: ' + JSON.stringify(marks));
  c.close();
});

test('no frames at all exits with code 5 and leaves no file', async () => {
  const dir = tmp('nof-');
  const out = path.join(dir, 'none.mkv');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 150, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
  await w.ready;
  w.stop();
  assert.equal(await w.done, 5);
  assert.equal(fs.existsSync(out), false);
});

test('browser disconnect mid-recording still finalises a playable file (exit 0)', async () => {
  const own = await launchChrome();
  try {
    const dir = tmp('dis-'); const out = path.join(dir, 'd.mkv');
    const w = startWorker({ wsUrl: own.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 150, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
    await w.ready;
    const c = await CdpClient.connect(own.wsUrl);
    const { targetId } = await c.send('Target.createTarget', { url: page('colour'), background: true });
    await waitForPaints(c, targetId, 4);
    own.proc.kill('SIGKILL');
    assert.equal(await w.done, 0, w.stderr());
    assert.ok(await duration(out) > 0);
  } finally { own.proc.kill('SIGKILL'); fs.rmSync(own.userDataDir, { recursive: true, force: true }); }
});

test('an encoder that cannot write its output exits 6, not 0', async () => {
  const dir = tmp('bad-'); const out = path.join(dir, 'missing-dir', 'x.mkv');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 150, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
  await w.ready;
  const c = await CdpClient.connect(chrome.wsUrl);
  const { targetId } = await c.send('Target.createTarget', { url: page('colour'), background: true });
  await waitForPaints(c, targetId, 3);
  w.stop();
  assert.equal(await w.done, 6);
  assert.match(w.stderr(), /missing-dir|No such file|Error/i);
  c.close();
});

test('setup errors are one JSON line on stderr and exit 1', async () => {
  const dir = tmp('set-');
  const w = startWorker({ wsUrl: 'ws://10.1.2.3:9222/devtools/browser/x', mode: 'newest', out: path.join(dir, 'a.mkv'), fps: 30, maxSeconds: 5, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
  assert.equal(await w.done, 1);
  const lines = w.stderr().trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, false); assert.equal(j.code, 'E_CDP_UNAVAILABLE'); assert.ok(j.fix);
});

test('closing the current tab while a switch is in flight never hangs the worker (repeated race)', async () => {
  const dir = tmp('race-'); const out = path.join(dir, 'r.mkv');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'follow', out, fps: 30, maxSeconds: 60, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
  await w.ready;
  const c = await CdpClient.connect(chrome.wsUrl);
  let prev = (await c.send('Target.createTarget', { url: page('colour'), background: true })).targetId;
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 8; i++) {
    const next = c.send('Target.createTarget', { url: page('grey'), background: true });
    await c.send('Target.closeTarget', { targetId: prev });   // close the tab being detached
    prev = (await next).targetId;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 500));
  w.stop();
  assert.equal(await w.done, 0, w.stderr());
  c.close();
});
