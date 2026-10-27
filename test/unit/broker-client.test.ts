import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ensureBroker, stopBroker, brokerStatus, isBrokerAlive, brokerIdleMs, brokerInfoPath, brokerReadyTimeoutMs, ALLOW_NOTICE_MS, type BrokerDeps } from '../../src/capture/cdp/broker-client.ts';
import type { BrokerInfo } from '../../src/capture/cdp/broker.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const UP = 'ws://127.0.0.1:9222/devtools/browser/aaa';

function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-')); dirs.push(d);
  const infoPath = path.join(d, 'chrome-broker.json');
  const write = (i: Partial<BrokerInfo>) => fs.writeFileSync(infoPath, JSON.stringify({ pid: 4242, port: 5000, token: 'a'.repeat(64), upstream: UP, startedAt: 1, ...i }));
  return { infoPath, write };
}

function fakeChild(pid: number) {
  const c = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), killed: '' as string, unref() {}, kill(sig?: string) { c.killed = sig ?? 'SIGTERM'; return true; } });
  return c;
}

/** spawn stub: behaves like a broker that writes its info file and prints ready. */
function spawner(infoPath: string, act: 'ready' | 'json-error' | 'exit' | 'hang' = 'ready', delayMs = 10) {
  const calls: any[] = [];
  const spawn: BrokerDeps['spawn'] = (cfg) => {
    calls.push(cfg);
    const c = fakeChild(9000 + calls.length);
    setTimeout(() => {
      if (act === 'ready') {
        fs.writeFileSync(infoPath, JSON.stringify({ pid: c.pid, port: 6000, token: 'b'.repeat(64), upstream: cfg.upstream, startedAt: 2 }));
        c.stdout.write('ready\n');
      } else if (act === 'json-error') {
        c.stderr.write(JSON.stringify({ ok: false, code: 'E_CDP_UNAVAILABLE', message: 'Timed out connecting', fix: 'Click Allow' }) + '\n');
        c.emit('exit', 1); c.emit('close', 1);
      } else if (act === 'exit') { c.emit('exit', 1); c.emit('close', 1); }
    }, delayMs);
    return c as any;
  };
  return { spawn, calls };
}

test('isBrokerAlive checks the command line, not just the pid (pid reuse)', () => {
  assert.equal(isBrokerAlive(1, () => '/usr/local/bin/node /x/dist/capture/cdp/broker.js {"upstream":"ws://..."}'), true);
  assert.equal(isBrokerAlive(1, () => 'node --import tsx /x/src/capture/cdp/broker.ts {}'), true);
  assert.equal(isBrokerAlive(1, () => '/Applications/Safari.app/Contents/MacOS/Safari'), false);
  assert.equal(isBrokerAlive(1, () => null), false);
});

test('a live broker for the same upstream is reused', async () => {
  const { infoPath, write } = setup(); write({});
  const s = spawner(infoPath);
  const r = await ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn });
  assert.deepEqual(r, { wsUrl: `ws://127.0.0.1:5000/${'a'.repeat(64)}`, started: false });
  assert.equal(s.calls.length, 0);
});

test('a stale pid, a reused pid or a different upstream starts a new broker', async () => {
  for (const [why, alive, upstream] of [['stale', () => false, UP], ['foreign pid', (pid: number) => isBrokerAlive(pid, () => 'some other process'), UP], ['other upstream', () => true, 'ws://127.0.0.1:9333/devtools/browser/bbb']] as const) {
    const { infoPath, write } = setup(); write({ upstream });
    const s = spawner(infoPath);
    const r = await ensureBroker(UP, { infoPath, alive, spawn: s.spawn, idleMs: 1234 });
    assert.equal(r.started, true, why);
    assert.equal(r.wsUrl, `ws://127.0.0.1:6000/${'b'.repeat(64)}`, why);
    assert.deepEqual(s.calls, [{ upstream: UP, idleMs: 1234, infoPath }], why);
  }
});

test('no info file starts a broker', async () => {
  const { infoPath } = setup();
  const s = spawner(infoPath);
  assert.equal((await ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn })).started, true);
});

test('a broker setup error is passed through with its code and fix', async () => {
  const { infoPath } = setup();
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => false, spawn: spawner(infoPath, 'json-error').spawn }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE' && e.fix === 'Click Allow' && /Timed out/.test(e.message));
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => false, spawn: spawner(infoPath, 'exit').spawn }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('a broker that never gets ready is killed after the timeout', async () => {
  const { infoPath } = setup();
  let child: any;
  const spawn: BrokerDeps['spawn'] = () => { child = fakeChild(77); return child; };
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => false, spawn, timeoutMs: 100 }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE' && /Allow/.test(e.fix));
  assert.equal(child.killed, 'SIGTERM');
});

test('brokerStatus reports only a live broker; stopBroker signals it or clears a stale file', async () => {
  const { infoPath, write } = setup();
  assert.equal(brokerStatus({ infoPath, alive: () => true }), null);
  write({});
  assert.equal(brokerStatus({ infoPath, alive: () => false }), null);
  assert.equal(brokerStatus({ infoPath, alive: () => true })?.pid, 4242);
  const killed: [number, string][] = [];
  let up = true;
  const ok = await stopBroker({ infoPath, alive: () => up, kill: (pid, sig) => { killed.push([pid, sig]); up = false; fs.rmSync(infoPath); } });
  assert.equal(ok, true);
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  write({});
  assert.equal(await stopBroker({ infoPath, alive: () => false, kill: () => { throw new Error('must not signal a dead or foreign pid'); } }), false);
  assert.equal(fs.existsSync(infoPath), false, 'stale info file removed');
});

test('idle timeout and info path defaults', () => {
  assert.equal(brokerIdleMs({}), 30 * 60 * 1000);
  assert.equal(brokerIdleMs({ SCREENREC_BROKER_IDLE: '5000' }), 5000);
  assert.equal(brokerIdleMs({ SCREENREC_BROKER_IDLE: 'soon' }), 30 * 60 * 1000);
  const prev = process.env.SCREENREC_HOME; process.env.SCREENREC_HOME = '/tmp/srh';
  try { assert.equal(brokerInfoPath(), '/tmp/srh/chrome-broker.json'); }
  finally { if (prev === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prev; }
});

test('stderr is read on close, not exit: a late JSON error line still comes through', async () => {
  const { infoPath } = setup();
  const spawn: BrokerDeps['spawn'] = () => {
    const c = fakeChild(55);
    setTimeout(() => c.emit('exit', 1), 5);
    setTimeout(() => { c.stderr.write(JSON.stringify({ ok: false, code: 'E_CDP_UNAVAILABLE', message: 'late line', fix: 'late fix' }) + '\n'); }, 30);
    setTimeout(() => c.emit('close', 1), 40);
    return c as any;
  };
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => false, spawn }), (e: ScreenrecError) => e.message === 'late line' && e.fix === 'late fix');
});

test('two concurrent ensureBroker calls start exactly one broker', async () => {
  const { infoPath } = setup();
  const s = spawner(infoPath, 'ready', 300);
  const [a, b] = await Promise.all([ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn }), ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn })]);
  assert.equal(s.calls.length, 1);
  assert.equal(a.wsUrl, b.wsUrl);
  assert.deepEqual([a.started, b.started].sort(), [false, true]);
  assert.equal(fs.existsSync(path.join(path.dirname(infoPath), 'chrome-broker.lock')), false, 'lock released');
});

test('a stale lock (dead holder, or older than the timeout) is broken; a live fresh one is waited on', async () => {
  for (const [why, lock, lockAlive] of [
    ['dead holder', { pid: 999999, at: Date.now(), cmd: 'node screenrec' }, () => false],
    ['too old', { pid: process.pid, at: Date.now() - 10 * 60_000, cmd: 'node screenrec' }, () => true],
  ] as const) {
    const { infoPath } = setup();
    fs.writeFileSync(path.join(path.dirname(infoPath), 'chrome-broker.lock'), JSON.stringify(lock));
    const s = spawner(infoPath);
    const r = await ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn, lockAlive, timeoutMs: 2000 });
    assert.equal(r.started, true, why); assert.equal(s.calls.length, 1, why);
  }
  const { infoPath } = setup();
  fs.writeFileSync(path.join(path.dirname(infoPath), 'chrome-broker.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), cmd: 'x' }));
  const s = spawner(infoPath);
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn, lockAlive: () => true, timeoutMs: 300 }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  assert.equal(s.calls.length, 0);
});

test('waiting longer than the notice delay calls onWaiting once; ready wait is the Allow timeout plus 5 s', async () => {
  assert.equal(ALLOW_NOTICE_MS, 2000);
  assert.equal(brokerReadyTimeoutMs({}), 125_000);
  assert.equal(brokerReadyTimeoutMs({ SCREENREC_ALLOW_TIMEOUT: '1000' }), 6000);
  const { infoPath, write } = setup();
  let n = 0;
  await ensureBroker(UP, { infoPath, alive: () => true, spawn: spawner(infoPath, 'ready', 200).spawn, noticeMs: 50, onWaiting: () => { n++; } });
  assert.equal(n, 1);
  write({});
  await ensureBroker(UP, { infoPath, alive: () => true, spawn: spawner(infoPath).spawn, noticeMs: 0, onWaiting: () => { n++; } });
  assert.equal(n, 1, 'a reused broker never waits');
});

const lockOf = (infoPath: string) => path.join(path.dirname(infoPath), 'chrome-broker.lock');

test('stale-lock break is compare-and-swap: a fresh lock taken meanwhile by another caller survives (no second broker)', async () => {
  const { infoPath } = setup();
  const lock = lockOf(infoPath);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now(), cmd: 'dead', nonce: 'old' }));  // left by a crash
  const s = spawner(infoPath);
  let simulated = false;
  // While this caller judges the old lock stale, caller B breaks it, takes a fresh lock and starts its broker.
  const lockAlive = (_pid: number, cmd: string) => {
    if (!simulated) {
      simulated = true;
      fs.rmSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), cmd: 'B', nonce: 'B' }));
      setTimeout(() => fs.writeFileSync(infoPath, JSON.stringify({ pid: 4321, port: 6100, token: 'c'.repeat(64), upstream: UP, startedAt: 3 })), 300);
    }
    return cmd === 'B';  // the crashed holder is dead; B is alive
  };
  const r = await ensureBroker(UP, { infoPath, alive: (pid) => pid === 4321, spawn: s.spawn, lockAlive, timeoutMs: 3000 });
  assert.equal(s.calls.length, 0, 'this caller must not start a second broker');
  assert.deepEqual(r, { wsUrl: `ws://127.0.0.1:6100/${'c'.repeat(64)}`, started: false });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).nonce, 'B', "B's lock is intact");
});

test('a dead holder whose broker is still waiting for Allow keeps the lock alive (Ctrl-C case)', async () => {
  const { infoPath } = setup();
  const lock = lockOf(infoPath);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now(), cmd: 'dead', nonce: 'n', brokerPid: 4242 }));
  const s = spawner(infoPath);
  setTimeout(() => fs.writeFileSync(infoPath, JSON.stringify({ pid: 4242, port: 6200, token: 'd'.repeat(64), upstream: UP, startedAt: 4 })), 400);
  const r = await ensureBroker(UP, { infoPath, alive: (pid) => pid === 4242, spawn: s.spawn, lockAlive: () => false, timeoutMs: 3000 });
  assert.equal(s.calls.length, 0);
  assert.equal(r.started, false); assert.equal(r.wsUrl, `ws://127.0.0.1:6200/${'d'.repeat(64)}`);
  // once that broker is gone too, the lock is stale and a new broker starts
  const two = setup();
  fs.writeFileSync(lockOf(two.infoPath), JSON.stringify({ pid: 999999, at: Date.now(), cmd: 'dead', nonce: 'n', brokerPid: 4242 }));
  const s2 = spawner(two.infoPath);
  assert.equal((await ensureBroker(UP, { infoPath: two.infoPath, alive: () => true, spawn: s2.spawn, lockAlive: () => false, timeoutMs: 3000, brokerAlive: () => false } as BrokerDeps)).started, true);
  assert.equal(s2.calls.length, 1);
});

test('the lock holder records the spawned broker pid while it waits', async () => {
  const { infoPath } = setup();
  const s = spawner(infoPath, 'ready', 300);
  const run = ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(lockOf(infoPath), 'utf8')).brokerPid, 9001);
  await run;
});

test('a live holder whose command line could not be read is not judged stale', async () => {
  const { infoPath } = setup();
  fs.writeFileSync(lockOf(infoPath), JSON.stringify({ pid: process.pid, at: Date.now(), cmd: '', nonce: 'x' }));
  const s = spawner(infoPath);
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => true, spawn: s.spawn, timeoutMs: 400 }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  assert.equal(s.calls.length, 0);
});

test('on win32 no broker is started: E_UNSUPPORTED_PLATFORM, nothing spawned', async () => {
  const { infoPath } = setup();
  const s = spawner(infoPath);
  await assert.rejects(ensureBroker(UP, { infoPath, alive: () => false, spawn: s.spawn, platform: 'win32' }),
    (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM' && /Windows/.test(e.message));
  assert.equal(s.calls.length, 0);
});

test('on win32 (no ps) broker liveness falls back to the pid, never reporting a live broker dead', () => {
  assert.equal(isBrokerAlive(process.pid, () => null, 'win32'), true);
  assert.equal(isBrokerAlive(2 ** 30, () => null, 'win32'), false);
});
