import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { launchChrome } from './launch.ts';
import { waitForPaints, centreColours } from './paint.ts';
import { CdpClient } from '../../src/capture/cdp/client.ts';
import { ensureBroker, brokerStatus, brokerInfoPath, stopBroker } from '../../src/capture/cdp/broker-client.ts';
const exec = promisify(execFile);

// Its own Chrome for Testing (headless, temp profile): the last test kills it.
const chrome = await launchChrome();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'srhome-'));
const prevHome = process.env.SCREENREC_HOME;
process.env.SCREENREC_HOME = home;
after(async () => {
  await stopBroker().catch(() => {});
  chrome.proc.kill('SIGKILL');
  if (prevHome === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prevHome;
  for (const d of [home, chrome.userDataDir, ...tmpDirs]) fs.rmSync(d, { recursive: true, force: true });
});

const base = new URL('../fixtures/colour-page.html', import.meta.url).href;
const workerTs = new URL('../../src/capture/cdp/worker.ts', import.meta.url).pathname;
const tmpDirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isGrey = (bucket: string) => new Set(bucket.split(',')).size === 1;

async function duration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

function startWorker(cfg: object) {
  const p = spawn(process.execPath, ['--import', 'tsx', workerTs], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += String(d); });
  const ready = new Promise<void>((r) => p.stdout.on('data', (d) => { if (String(d).includes('ready')) r(); }));
  const done = new Promise<number>((r) => {
    const t = setTimeout(() => { console.error('HUNG stderr:', stderr); p.kill('SIGKILL'); r(-999); }, 180000);
    p.on('exit', (c) => { clearTimeout(t); r(c ?? -1); });
  });
  p.stdin.on('error', () => {});
  p.stdin.write(JSON.stringify(cfg) + '\n');  // config on stdin, as the recorder sends it
  return { stop: () => p.stdin.write('stop\n'), done, ready, stderr: () => stderr };
}

function workerCfg(dir: string, name: string, extra: object) {
  return { out: path.join(dir, `${name}.mkv`), fps: 30, maxSeconds: 150, marksFile: path.join(dir, `${name}.jsonl`), t0Ms: Date.now(), ...extra };
}

let brokerWs = '';

test('ensureBroker starts one broker for Chrome and reuses it', async () => {
  const first = await ensureBroker(chrome.wsUrl);
  assert.equal(first.started, true);
  assert.match(first.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
  const again = await ensureBroker(chrome.wsUrl);
  assert.deepEqual(again, { wsUrl: first.wsUrl, started: false });
  assert.equal(fs.statSync(brokerInfoPath()).mode & 0o777, 0o600);
  assert.equal(brokerStatus()?.upstream, chrome.wsUrl);
  brokerWs = first.wsUrl;
});

test('the broker refuses CDP calls screenrec does not make, so its token never grants the whole browser', async () => {
  const c = await CdpClient.connect(brokerWs);
  try {
    await assert.rejects(c.send('Target.createTarget', { url: 'about:blank' }), /not allowed through the screenrec broker/);
    await assert.rejects(c.send('Storage.getCookies', {}), /not allowed through the screenrec broker/);
    assert.ok((await c.send('Target.getTargets')).targetInfos.length >= 1);
  } finally { c.close(); }
});

// The "agent" that opens tabs talks to Chrome for Testing directly; only the workers use the broker.
test('two workers in a row through the broker each record a background tab with live colours', async () => {
  const c = await CdpClient.connect(chrome.wsUrl);
  try {
    for (const name of ['seq1', 'seq2']) {
      const dir = tmp(`${name}-`);
      const cfg = workerCfg(dir, name, { wsUrl: brokerWs, mode: 'newest' });
      const w = startWorker(cfg);
      await w.ready;
      const { targetId } = await c.send('Target.createTarget', { url: `${base}?${name}`, background: true });
      await waitForPaints(c, targetId, 6);
      w.stop();
      assert.equal(await w.done, 0, w.stderr());
      assert.ok(await duration(cfg.out) > 2, name);
      const colours = await centreColours(cfg.out);
      assert.ok(colours.size >= 4, `${name}: distinct colours ${colours.size}`);
      await c.send('Target.closeTarget', { targetId });
    }
  } finally { c.close(); }
});

test('two workers at once through the broker record two tabs without seeing each other\'s frames', async () => {
  const c = await CdpClient.connect(chrome.wsUrl);
  try {
    const dir = tmp('conc-');
    const a = workerCfg(dir, 'a', { wsUrl: brokerWs, mode: 'url', pattern: 'tabA' });
    const b = workerCfg(dir, 'b', { wsUrl: brokerWs, mode: 'url', pattern: 'tabB' });
    const wa = startWorker(a); const wb = startWorker(b);
    await Promise.all([wa.ready, wb.ready]);
    const ta = await c.send('Target.createTarget', { url: `${base}?tabA`, background: true });
    const tb = await c.send('Target.createTarget', { url: `${base}?grey&tabB`, background: true });
    await Promise.all([waitForPaints(c, ta.targetId, 6), waitForPaints(c, tb.targetId, 6)]);
    wa.stop(); wb.stop();
    assert.equal(await wa.done, 0, wa.stderr());
    assert.equal(await wb.done, 0, wb.stderr());
    const ca = await centreColours(a.out); const cb = await centreColours(b.out);
    assert.ok(ca.size >= 4, `A distinct colours ${[...ca]}`);
    assert.ok([...ca].some((x) => !isGrey(x)), `A must show the colour page: ${[...ca]}`);
    assert.ok(cb.size >= 3, `B distinct colours ${[...cb]}`);
    assert.ok([...cb].every(isGrey), `B must show only the grey page: ${[...cb]}`);
  } finally { c.close(); }
});

test('when Chrome quits, the broker exits and removes its info file', async () => {
  const info = brokerStatus();
  assert.ok(info, 'broker running');
  chrome.proc.kill('SIGKILL');
  const alive = () => { try { process.kill(info.pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && (alive() || fs.existsSync(brokerInfoPath())); i++) await sleep(100);
  assert.equal(alive(), false, 'broker process exited');
  assert.equal(fs.existsSync(brokerInfoPath()), false, 'info file removed');
});
