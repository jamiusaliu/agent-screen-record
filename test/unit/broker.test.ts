import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWsServer, type WsConnection } from '../../src/capture/cdp/ws-server.ts';
import { runBroker, brokerUrl, allowTimeoutMs, type BrokerInfo } from '../../src/capture/cdp/broker.ts';
import { CdpClient } from '../../src/capture/cdp/client.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const tmpDirs: string[] = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-')); tmpDirs.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { targetId: 'T1', type: 'page', url: 'https://a.example/', title: 'A', attached: false },
  { targetId: 'T2', type: 'page', url: 'https://b.example/', title: 'B', attached: false },
];

// A fake Chrome browser endpoint: answers the Target.* calls the workers use.
async function fakeChrome() {
  const received: any[] = [];
  const conns: WsConnection[] = [];
  let n = 0;
  const emit = (m: object) => { for (const c of conns) c.send(JSON.stringify(m)); };
  const srv = await createWsServer({
    onConnection: (c) => {
      conns.push(c);
      c.onMessage((raw) => {
        const m = JSON.parse(raw); received.push(m);
        const reply = (result: object) => c.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
        switch (m.method) {
          case 'Target.getTargets': return reply({ targetInfos: TARGETS });
          case 'Target.setDiscoverTargets':
            if (m.params?.discover) for (const t of TARGETS) emit({ method: 'Target.targetCreated', params: { targetInfo: t } });
            return reply({});
          case 'Target.attachToTarget': {
            const sessionId = `S${++n}`;
            emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: TARGETS.find((t) => t.targetId === m.params.targetId), waitingForDebugger: false } });
            return reply({ sessionId });
          }
          case 'Target.detachFromTarget':
            emit({ method: 'Target.detachedFromTarget', params: { sessionId: m.params.sessionId } });
            return reply({});
          case 'Page.getLayoutMetrics': return reply({ echo: m.params });
          default: return reply({});
        }
      });
    },
  });
  return {
    wsUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`, received, emit,
    connections: () => conns.length,
    dropAll: () => { for (const c of conns) c.close(1000); },
    close: () => srv.close(),
  };
}

async function startBroker(upstream: string, idleMs = 60_000, err?: (s: string) => void) {
  const dir = tmp();
  const infoPath = path.join(dir, 'home', 'chrome-broker.json');
  let ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const done = runBroker({ upstream, idleMs, infoPath }, { out: (s) => { if (s.includes('ready')) ready(); }, err: err ?? (() => {}) });
  await Promise.race([readyP, done.then((c) => { throw new Error(`broker exited ${c} before ready`); })]);
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as BrokerInfo;
  return { info, infoPath, done, url: brokerUrl(info) };
}

async function client(url: string) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)); msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
  return {
    msgs, closed,
    send: (m: object) => ws.send(JSON.stringify(m)),
    next: (pred: (m: any) => boolean, ms = 2000) => {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no matching message')), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

async function rawUpgrade(port: number, pathName: string, origin?: string, host = `127.0.0.1:${port}`): Promise<string> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(`GET ${pathName} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
  const head = await new Promise<string>((r) => sock.once('data', (d) => r(String(d))));
  sock.destroy();
  return head.split('\r\n')[0];
}

test('rule 1: exact path token only (1008 otherwise), loopback bind, hostile Origin refused, info file 0600', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    assert.match(b.info.token, /^[0-9a-f]{64}$/);
    assert.equal(b.info.upstream, up.wsUrl);
    assert.equal(b.info.pid, process.pid);
    assert.equal(b.url, `ws://127.0.0.1:${b.info.port}/${b.info.token}`);
    assert.equal(fs.statSync(b.infoPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(b.infoPath)).mode & 0o777, 0o700);
    for (const bad of ['/', '/nope', `/${b.info.token}x`, `/${b.info.token.slice(0, -1)}`, `/${b.info.token}/`]) {
      const ws = new WebSocket(`ws://127.0.0.1:${b.info.port}${bad}`);
      ws.onerror = () => {};
      assert.equal(await new Promise<number>((r) => { ws.onclose = (e) => r(e.code); }), 1008, bad);
    }
    assert.match(await rawUpgrade(b.info.port, `/${b.info.token}`, 'https://evil.example'), / 403 /);
    assert.match(await rawUpgrade(b.info.port, `/${b.info.token}`, 'http://127.0.0.1:8080'), / 403 /);
    assert.match(await rawUpgrade(b.info.port, `/${b.info.token}`, 'http://localhost'), / 101 /);
    assert.match(await rawUpgrade(b.info.port, `/${b.info.token}`, 'http://127.0.0.1'), / 101 /);
    assert.match(await rawUpgrade(b.info.port, `/${b.info.token}`), / 101 /);
    const v6 = await new Promise<boolean>((r) => { const s = net.connect(b.info.port, '::1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    assert.equal(v6, false, 'must not listen on ::1');
    const ok = await client(b.url);
    ok.send({ id: 1, method: 'Page.getLayoutMetrics', params: {} });
    assert.equal((await ok.next((m) => m.id === 1)).result.echo !== undefined, true);
    ok.close();
    assert.equal(up.connections(), 1);
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 2: client ids are remapped upstream and restored on the way back', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url); const c = await client(b.url);
    a.send({ id: 1, method: 'Page.getLayoutMetrics', params: { who: 'a' } });
    c.send({ id: 1, method: 'Page.getLayoutMetrics', params: { who: 'c' } });
    const ra = await a.next((m) => m.id === 1); const rc = await c.next((m) => m.id === 1);
    assert.equal(ra.result.echo.who, 'a'); assert.equal(rc.result.echo.who, 'c');
    const ids = up.received.filter((m) => m.method === 'Page.getLayoutMetrics').map((m) => m.id);
    assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
    assert.equal(a.msgs.filter((m) => m.id !== undefined).length, 1);
    a.close(); c.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 3: session traffic goes only to the client that attached; foreign sessions are refused', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url); const c = await client(b.url);
    a.send({ id: 7, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
    const sa = (await a.next((m) => m.id === 7)).result.sessionId;
    c.send({ id: 7, method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } });
    const sc = (await c.next((m) => m.id === 7)).result.sessionId;
    assert.ok(a.msgs.some((m) => m.method === 'Target.attachedToTarget' && m.params.sessionId === sa));
    assert.ok(!a.msgs.some((m) => m.method === 'Target.attachedToTarget' && m.params.sessionId === sc));
    assert.ok(!c.msgs.some((m) => m.method === 'Target.attachedToTarget' && m.params.sessionId === sa));
    a.send({ id: 8, method: 'Page.getLayoutMetrics', params: { x: 1 }, sessionId: sa });
    const r8 = await a.next((m) => m.id === 8);
    assert.equal(r8.sessionId, sa);
    up.emit({ method: 'Page.loadEventFired', params: {}, sessionId: sa });
    up.emit({ method: 'Page.loadEventFired', params: {}, sessionId: sc });
    await a.next((m) => m.method === 'Page.loadEventFired'); await c.next((m) => m.method === 'Page.loadEventFired');
    assert.ok(a.msgs.filter((m) => m.method === 'Page.loadEventFired').every((m) => m.sessionId === sa));
    assert.ok(c.msgs.filter((m) => m.method === 'Page.loadEventFired').every((m) => m.sessionId === sc));
    // a client may not drive another client's session
    const before = up.received.length;
    a.send({ id: 9, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: sc });
    const r9 = await a.next((m) => m.id === 9);
    assert.ok(r9.error);
    assert.equal(up.received.slice(before).some((m) => m.method === 'Runtime.evaluate'), false);
    a.close(); c.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 4: browser-level events go to clients that enabled discovery; discovery is shared, not clobbered', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url); const c = await client(b.url);
    a.send({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await a.next((m) => m.id === 1);
    assert.equal(a.msgs.filter((m) => m.method === 'Target.targetCreated').length, TARGETS.length);
    up.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3', type: 'page', url: 'x', title: 'x' } } });
    await a.next((m) => m.method === 'Target.targetCreated' && m.params.targetInfo.targetId === 'T3');
    await sleep(50);
    assert.equal(c.msgs.some((m) => m.method === 'Target.targetCreated'), false);
    // the second client to enable discovery gets the existing targets, like Chrome would send them
    c.send({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await c.next((m) => m.id === 1);
    assert.deepEqual(c.msgs.filter((m) => m.method === 'Target.targetCreated').map((m) => m.params.targetInfo.targetId), TARGETS.map((t) => t.targetId));
    assert.equal(up.received.filter((m) => m.method === 'Target.setDiscoverTargets').length, 1);
    // one client turning discovery off must not turn it off for the other
    a.send({ id: 2, method: 'Target.setDiscoverTargets', params: { discover: false } });
    await a.next((m) => m.id === 2);
    assert.equal(up.received.filter((m) => m.method === 'Target.setDiscoverTargets').length, 1);
    up.emit({ method: 'Target.targetDestroyed', params: { targetId: 'T3' } });
    await c.next((m) => m.method === 'Target.targetDestroyed');
    await sleep(50);
    assert.equal(a.msgs.some((m) => m.method === 'Target.targetDestroyed'), false);
    a.close(); c.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 5: a disconnecting client has its sessions detached and its traffic stops', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url); const c = await client(b.url);
    c.send({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await c.next((m) => m.id === 1);
    a.send({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
    const s1 = (await a.next((m) => m.id === 1)).result.sessionId;
    a.send({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } });
    const s2 = (await a.next((m) => m.id === 2)).result.sessionId;
    a.close();
    for (let i = 0; i < 40 && up.received.filter((m) => m.method === 'Target.detachFromTarget').length < 2; i++) await sleep(25);
    assert.deepEqual(up.received.filter((m) => m.method === 'Target.detachFromTarget').map((m) => m.params.sessionId).sort(), [s1, s2].sort());
    up.emit({ method: 'Page.screencastFrame', params: { data: 'AAAA', sessionId: 1 }, sessionId: s1 });
    await sleep(100);
    assert.equal(c.msgs.some((m) => m.method === 'Page.screencastFrame' || m.method === 'Target.detachedFromTarget'), false);
    c.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 6: upstream closing closes every client with 1001, removes the info file, exits 0', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  const a = await client(b.url); const c = await client(b.url);
  up.dropAll();
  assert.equal(await a.closed, 1001); assert.equal(await c.closed, 1001);
  assert.equal(await b.done, 0);
  assert.equal(fs.existsSync(b.infoPath), false);
  await up.close();
});

test('rule 7: idle exit after idleMs with no client, info file removed; a connected client keeps it alive', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl, 300);
  let exited = false; void b.done.then(() => { exited = true; });
  const a = await client(b.url);
  await sleep(600);
  assert.equal(exited, false, 'must not idle out while a client is connected');
  a.close();
  const t0 = Date.now();
  assert.equal(await b.done, 0);
  assert.ok(Date.now() - t0 >= 250, `exited after ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(b.infoPath), false);
  await up.close();
});

test('rule 8: two CdpClient workers record two tabs at once without seeing each other\'s frames', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const w1 = await CdpClient.connect(b.url); const w2 = await CdpClient.connect(b.url);
    const s1 = (await w1.send<{ sessionId: string }>('Target.attachToTarget', { targetId: 'T1', flatten: true })).sessionId;
    const s2 = (await w2.send<{ sessionId: string }>('Target.attachToTarget', { targetId: 'T2', flatten: true })).sessionId;
    const f1: string[] = []; const f2: string[] = [];
    w1.on('Page.screencastFrame', (p, sid) => f1.push(`${sid}:${p.data}`));
    w2.on('Page.screencastFrame', (p, sid) => f2.push(`${sid}:${p.data}`));
    const big = 'J'.repeat(4 * 1024 * 1024);   // screencast frames are several MB
    for (let i = 0; i < 5; i++) {
      up.emit({ method: 'Page.screencastFrame', params: { data: `one${i}`, sessionId: i }, sessionId: s1 });
      up.emit({ method: 'Page.screencastFrame', params: { data: i === 2 ? big : `two${i}`, sessionId: i }, sessionId: s2 });
    }
    for (let i = 0; i < 80 && (f1.length < 5 || f2.length < 5); i++) await sleep(25);
    assert.deepEqual(f1, [0, 1, 2, 3, 4].map((i) => `${s1}:one${i}`));
    assert.equal(f2.length, 5); assert.ok(f2.every((f) => f.startsWith(`${s2}:`)));
    assert.equal(f2[2].length, s2.length + 1 + big.length);
    w1.close(); w2.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('SCREENREC_DEBUG logs method names and ids, never message contents', async () => {
  const prev = process.env.SCREENREC_DEBUG; process.env.SCREENREC_DEBUG = '1';
  const logs: string[] = [];
  const up = await fakeChrome();
  try {
    const b = await startBroker(up.wsUrl, 60_000, (s) => logs.push(s));
    const a = await client(b.url);
    a.send({ id: 3, method: 'Page.getLayoutMetrics', params: { secret: 'TOPSECRET-123' } });
    await a.next((m) => m.id === 3);
    up.emit({ method: 'Target.targetCreated', params: { targetInfo: { url: 'https://private.example/TOPSECRET' } } });
    await sleep(50);
    a.close(); up.dropAll(); await b.done;
    const all = logs.join('');
    assert.match(all, /Page\.getLayoutMetrics/);
    assert.doesNotMatch(all, /TOPSECRET|private\.example/);
    assert.doesNotMatch(all, new RegExp(b.info.token));
  } finally { if (prev === undefined) delete process.env.SCREENREC_DEBUG; else process.env.SCREENREC_DEBUG = prev; await up.close(); }
});

test('an unreachable upstream rejects with E_CDP_UNAVAILABLE and writes no info file', async () => {
  const dir = tmp(); const infoPath = path.join(dir, 'chrome-broker.json');
  const free = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  await assert.rejects(runBroker({ upstream: `ws://127.0.0.1:${free}/devtools/browser/x`, idleMs: 1000, infoPath }, { out: () => {}, err: () => {} }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  await assert.rejects(runBroker({ upstream: 'ws://10.1.2.3:9222/devtools/browser/x', idleMs: 1000, infoPath }, { out: () => {}, err: () => {} }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  assert.equal(fs.existsSync(infoPath), false);
});

test('process entry: setup errors are one JSON line on stderr and exit 1', async () => {
  const entry = new URL('../../src/capture/cdp/broker.ts', import.meta.url).pathname;
  const dir = tmp();
  const p = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.end(JSON.stringify({ upstream: 'ws://10.1.2.3:9222/devtools/browser/x', idleMs: 1000, infoPath: path.join(dir, 'b.json') }) + '\n');
  let stderr = ''; let stdout = '';
  p.stderr.on('data', (d) => { stderr += String(d); }); p.stdout.on('data', (d) => { stdout += String(d); });
  const code = await new Promise<number>((r) => p.on('exit', (c) => r(c ?? -1)));
  assert.equal(code, 1);
  assert.equal(stdout, '');
  const lines = stderr.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, false); assert.equal(j.code, 'E_CDP_UNAVAILABLE'); assert.ok(j.fix);
});

test('Host header must be 127.0.0.1 or localhost (with an optional port)', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const p = `/${b.info.token}`;
    assert.match(await rawUpgrade(b.info.port, p, undefined, 'evil.example'), / 403 /);
    assert.match(await rawUpgrade(b.info.port, p, undefined, `evil.example:${b.info.port}`), / 403 /);
    assert.match(await rawUpgrade(b.info.port, p, undefined, '127.0.0.1.evil.example'), / 403 /);
    assert.match(await rawUpgrade(b.info.port, p, undefined, `localhost:${b.info.port}`), / 101 /);
    assert.match(await rawUpgrade(b.info.port, p, undefined, 'localhost'), / 101 /);
    assert.match(await rawUpgrade(b.info.port, p, undefined, '127.0.0.1'), / 101 /);
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('rule 9: only the CDP calls screenrec makes pass the broker; everything else is refused before Chrome sees it', async () => {
  // The broker skips Chrome's Allow dialog, so whoever reads the token (any process of this user, an
  // agent with a shell) must not get the whole browser: no navigation, cookies, input or arbitrary JS.
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url);
    a.send({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
    const own = (await a.next((m) => m.id === 1)).result.sessionId;
    const before = up.received.length;
    const refused: [string, object, string?][] = [
      ['Target.createTarget', { url: 'https://evil.example/' }],
      ['Target.closeTarget', { targetId: 'T2' }],
      ['Target.exposeDevToolsProtocol', { targetId: 'T1' }],
      ['Target.attachToTarget', { targetId: 'T2' }],  // non-flat sessions would need sendMessageToTarget
      ['Target.sendMessageToTarget', { sessionId: own, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }) }],
      ['Browser.close', {}],
      ['Network.getAllCookies', {}],
      ['Storage.getCookies', {}],
      ['Page.navigate', { url: 'https://evil.example/' }, own],
      ['Input.dispatchKeyEvent', { type: 'char', text: 'x' }, own],
      ['Runtime.evaluate', { expression: 'document.cookie', returnByValue: true }, own],
      ['Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true, includeCommandLineAPI: true }, own],
      ['Runtime.callFunctionOn', { functionDeclaration: '() => document.cookie' }, own],
      ['Network.enable', {}, own],
    ];
    let id = 100;
    for (const [method, params, sessionId] of refused) {
      a.send({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) });
      const r = await a.next((m) => m.id === id);
      assert.equal(r.error?.code, -32601, `${method} ${JSON.stringify(params)} refused`);
      if (sessionId) assert.equal(r.sessionId, sessionId);
    }
    assert.deepEqual(up.received.slice(before), [], 'Chrome saw none of them');
    // what the workers and the screenshot command send still goes through
    const allowed: [string, object, string?][] = [
      ['Target.getTargets', {}],
      ['Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, own],
      ['Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, own],
      ['Page.enable', {}, own], ['Page.getLayoutMetrics', {}, own],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }, own],
      ['Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 }, own],
      ['Page.screencastFrameAck', { sessionId: 1 }, own], ['Page.stopScreencast', {}, own],
      ['Page.captureScreenshot', { format: 'png' }, own],
      ['Target.detachFromTarget', { sessionId: own }],
    ];
    for (const [method, params, sessionId] of allowed) {
      a.send({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) });
      assert.ok((await a.next((m) => m.id === id)).result, `${method} allowed`);
    }
    a.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('detachFromTarget or sendMessageToTarget by targetId alone are refused', async () => {
  const up = await fakeChrome();
  const b = await startBroker(up.wsUrl);
  try {
    const a = await client(b.url);
    a.send({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
    const own = (await a.next((m) => m.id === 1)).result.sessionId;
    const before = up.received.length;
    a.send({ id: 2, method: 'Target.detachFromTarget', params: { targetId: 'T2' } });
    a.send({ id: 3, method: 'Target.sendMessageToTarget', params: { targetId: 'T2', message: '{}' } });
    assert.ok((await a.next((m) => m.id === 2)).error);
    assert.ok((await a.next((m) => m.id === 3)).error);
    assert.equal(up.received.slice(before).some((m) => m.id !== undefined && /detachFromTarget|sendMessageToTarget/.test(m.method)), false);
    a.send({ id: 4, method: 'Target.detachFromTarget', params: { sessionId: own } });
    assert.ok((await a.next((m) => m.id === 4)).result);
    a.close();
  } finally { up.dropAll(); await b.done; await up.close(); }
});

test('upstream lost while the server starts: no info file, no ready, E_CDP_UNAVAILABLE', async () => {
  const up = await fakeChrome();
  const dir = tmp(); const infoPath = path.join(dir, 'chrome-broker.json');
  const out: string[] = [];
  const run = runBroker({ upstream: up.wsUrl, idleMs: 60_000, infoPath }, {
    out: (s) => out.push(s), err: () => {},
    beforeListen: async () => { up.dropAll(); await sleep(200); },
  });
  await assert.rejects(run, (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  assert.deepEqual(out, []);
  assert.equal(fs.existsSync(infoPath), false);
  await up.close();
});

test('upstream connect errors hide the URL path; Allow timeout defaults to 120 s', async () => {
  const free = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  await assert.rejects(runBroker({ upstream: `ws://127.0.0.1:${free}/devtools/browser/SECRETUUID`, idleMs: 1000, infoPath: path.join(tmp(), 'x.json') }, { out: () => {}, err: () => {} }),
    (e: ScreenrecError) => !e.message.includes('SECRETUUID') && /<redacted>/.test(e.message));
  assert.equal(allowTimeoutMs({}), 120_000);
  assert.equal(allowTimeoutMs({ SCREENREC_ALLOW_TIMEOUT: '3000' }), 3000);
  assert.equal(allowTimeoutMs({ SCREENREC_ALLOW_TIMEOUT: 'x' }), 120_000);
});

test('a broker started by ensureBroker never shows its upstream (Chrome browser id) in argv', async () => {
  const { ensureBroker } = await import('../../src/capture/cdp/broker-client.ts');
  const { execFileSync } = await import('node:child_process');
  // an "upstream" that accepts TCP and never answers, so the broker sits in its Allow wait
  const held: net.Socket[] = [];
  const srv = net.createServer((s) => { held.push(s); s.on('error', () => {}); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const upstream = `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}/devtools/browser/SECRET-BROWSER-ID`;
  const infoPath = path.join(tmp(), 'chrome-broker.json');
  try {
    const run = ensureBroker(upstream, { infoPath, timeoutMs: 6000 });
    run.catch(() => {});
    for (let i = 0; i < 200 && held.length === 0; i++) await sleep(25);
    const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(infoPath), 'chrome-broker.lock'), 'utf8'));
    assert.ok(lock.brokerPid > 0, 'lock records the broker pid');
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(lock.brokerPid)], { encoding: 'utf8' });
    assert.match(cmd, /capture\/cdp\/broker\./);
    assert.doesNotMatch(cmd, /SECRET-BROWSER-ID|devtools\/browser/);
    try { process.kill(lock.brokerPid, 'SIGTERM'); } catch { /* gone */ }
    await assert.rejects(run);
  } finally { srv.close(); for (const s of held) s.destroy(); }
});
