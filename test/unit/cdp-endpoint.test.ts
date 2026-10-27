import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { assertLoopback, readDevToolsActivePort, resolveEndpoint, chromeUserDataDirs } from '../../src/capture/cdp/endpoint.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('only loopback hosts are allowed', () => {
  for (const u of ['ws://127.0.0.1:9222/devtools/browser/x', 'http://localhost:9222', 'ws://[::1]:9222/x']) assertLoopback(u);
  for (const u of ['ws://10.0.0.5:9222/x', 'http://example.com:9222', 'ws://127.0.0.1.evil.com/x'])
    assert.throws(() => assertLoopback(u), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('DevToolsActivePort is parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'));
  assert.equal(readDevToolsActivePort(dir), null);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '53123\n/devtools/browser/abc-123\n');
  assert.deepEqual(readDevToolsActivePort(dir), { port: 53123, path: '/devtools/browser/abc-123' });
});

test('resolveEndpoint order: flag, env, chrome dirs (through the broker), else E_CDP_UNAVAILABLE', async () => {
  const fetchJson = async (u: string) => { assert.equal(u, 'http://127.0.0.1:9222/json/version'); return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/F' }; };
  assert.deepEqual(await resolveEndpoint({ cdp: 'http://127.0.0.1:9222', fetchJson, dirs: [] }), { wsUrl: 'ws://127.0.0.1:9222/devtools/browser/F', source: 'flag' });
  assert.deepEqual(await resolveEndpoint({ env: { SCREENREC_CDP: 'ws://127.0.0.1:1/devtools/browser/E' }, dirs: [] }), { wsUrl: 'ws://127.0.0.1:1/devtools/browser/E', source: 'env' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud2-'));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '4444\n/devtools/browser/C\n');
  const asked: string[] = [];
  const ensureBroker = async (up: string) => { asked.push(up); return { wsUrl: 'ws://127.0.0.1:7777/tok', started: true }; };
  assert.deepEqual(await resolveEndpoint({ env: {}, dirs: ['/nope', dir], ensureBroker }), { wsUrl: 'ws://127.0.0.1:7777/tok', source: 'broker' });
  assert.deepEqual(asked, ['ws://127.0.0.1:4444/devtools/browser/C']);
  await assert.rejects(resolveEndpoint({ env: {}, dirs: [], ensureBroker }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE' && /chrome:\/\/inspect/.test(e.fix));
  await assert.rejects(resolveEndpoint({ cdp: 'http://192.168.1.2:9222', dirs: [] }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('user data dirs include Chrome on each platform', () => {
  assert.ok(chromeUserDataDirs('darwin', '/Users/a').includes('/Users/a/Library/Application Support/Google/Chrome'));
  assert.ok(chromeUserDataDirs('linux', '/home/a').includes('/home/a/.config/google-chrome'));
  assert.ok(chromeUserDataDirs('win32', 'C:\\Users\\a', { LOCALAPPDATA: 'C:\\L' }).some((d) => d.includes('Google') && d.includes('Chrome')));
});

test('default discovery never follows redirects', async () => {
  const http = await import('node:http');
  let hit = false;
  const target = http.createServer((_q, r) => { hit = true; r.end('{}'); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const tp = (target.address() as any).port;
  const redir = http.createServer((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${tp}/json/version` }); r.end(); });
  await new Promise<void>((r) => redir.listen(0, '127.0.0.1', () => r()));
  const rp = (redir.address() as any).port;
  try {
    await assert.rejects(resolveEndpoint({ cdp: `http://127.0.0.1:${rp}`, dirs: [] }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
    assert.equal(hit, false);
  } finally { target.close(); redir.close(); }
});

test('endpoint 1 (--cdp, SCREENREC_CDP) never uses the broker', async () => {
  const ensureBroker = async () => { throw new Error('broker must not be used for endpoint 1'); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud3-'));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '4444\n/devtools/browser/C\n');
  assert.equal((await resolveEndpoint({ cdp: 'ws://127.0.0.1:1/devtools/browser/F', dirs: [dir], ensureBroker })).source, 'flag');
  assert.equal((await resolveEndpoint({ env: { SCREENREC_CDP: 'ws://127.0.0.1:1/devtools/browser/E' }, dirs: [dir], ensureBroker })).source, 'env');
});

test('redactUrl keeps scheme, host and port, hides the path', async () => {
  const { redactUrl } = await import('../../src/capture/cdp/endpoint.ts');
  assert.equal(redactUrl(`ws://127.0.0.1:5000/${'f'.repeat(64)}`), 'ws://127.0.0.1:5000/<redacted>');
  assert.equal(redactUrl('ws://127.0.0.1:9222/devtools/browser/abc'), 'ws://127.0.0.1:9222/<redacted>');
  assert.equal(redactUrl('http://localhost:9222'), 'http://localhost:9222');
  assert.equal(redactUrl('not a url'), '<redacted url>');
  assert.throws(() => assertLoopback(`ws://10.0.0.1:1/${'e'.repeat(64)}`), (e: Error) => !e.message.includes('e'.repeat(64)));
});

test('probeOnly reports endpoint 2 without starting the broker; onWaiting reaches ensureBroker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud4-'));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '4444\n/devtools/browser/C\n');
  const never = async () => { throw new Error('doctor must not start a broker'); };
  assert.deepEqual(await resolveEndpoint({ env: {}, dirs: [dir], ensureBroker: never, probeOnly: true }), { wsUrl: 'ws://127.0.0.1:4444/devtools/browser/C', source: 'chrome' });
  let seen: unknown;
  const onWaiting = () => {};
  await resolveEndpoint({ env: {}, dirs: [dir], onWaiting, ensureBroker: async (_u, o) => { seen = o?.onWaiting; return { wsUrl: 'ws://127.0.0.1:1/t', started: true }; } });
  assert.equal(seen, onWaiting);
});
