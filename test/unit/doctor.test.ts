import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { doctorCommand } from '../../src/commands/doctor.ts';
import { resolveEndpoint } from '../../src/capture/cdp/endpoint.ts';

const args = { command: 'doctor', positionals: [], values: {}, json: true };

test('doctor finds endpoint 2 without connecting, spawning a broker or writing broker files', async () => {
  // "Chrome": a listening socket named by DevToolsActivePort that counts every connection
  let connections = 0;
  const srv = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-ud-'));
  fs.writeFileSync(path.join(ud, 'DevToolsActivePort'), `${port}\n/devtools/browser/doctor-uuid\n`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-home-'));
  const prev = { home: process.env.SCREENREC_HOME, cdp: process.env.SCREENREC_CDP, WS: globalThis.WebSocket };
  process.env.SCREENREC_HOME = home; delete process.env.SCREENREC_CDP;
  let wsOpened = 0;
  (globalThis as any).WebSocket = class { constructor() { wsOpened++; throw new Error('doctor must not open a WebSocket'); } };
  try {
    const r = await doctorCommand({ dirs: [ud], ensureBroker: async () => { throw new Error('doctor must not start the broker'); } })(args);
    await new Promise((res) => setTimeout(res, 300));
    const tab = (r.checks as any[]).find((c) => c.name === 'Chrome tab capture');
    assert.equal(tab.ok, true);
    assert.equal(tab.detail, `endpoint found (port ${port}), broker not running`);
    assert.doesNotMatch(JSON.stringify(r), /doctor-uuid/);
    assert.ok((r.checks as any[]).some((c) => c.name === 'Chrome broker'));
    assert.equal(connections, 0, 'no socket opened to Chrome');
    assert.equal(wsOpened, 0);
    assert.deepEqual(fs.readdirSync(home), [], 'no broker info or lock file');
  } finally {
    (globalThis as any).WebSocket = prev.WS;
    if (prev.home === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prev.home;
    if (prev.cdp !== undefined) process.env.SCREENREC_CDP = prev.cdp;
    srv.close(); fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probeOnly never fetches endpoint 1 either', async () => {
  const fetchJson = async () => { throw new Error('probeOnly must not fetch'); };
  assert.deepEqual(await resolveEndpoint({ env: { SCREENREC_CDP: 'http://127.0.0.1:9333' }, dirs: [], fetchJson, probeOnly: true }), { wsUrl: 'http://127.0.0.1:9333', source: 'env' });
  assert.deepEqual(await resolveEndpoint({ cdp: 'http://127.0.0.1:9334', dirs: [], fetchJson, probeOnly: true }), { wsUrl: 'http://127.0.0.1:9334', source: 'flag' });
});

test('doctor summary: optional warnings never fail allPassed and their fixes show in text', async () => {
  const { summarize } = await import('../../src/commands/doctor.ts');
  const s = summarize([
    { name: 'node', ok: true, detail: '24' },
    { name: 'Chrome tab capture', ok: false, warn: true, detail: 'remote debugging not enabled', fix: 'enable it' },
    { name: 'Chrome windows', ok: true, warn: true, detail: 'Chrome pauses drawing covered windows', fix: 'keep it uncovered' },
  ]);
  assert.equal(s.allPassed, true);
  assert.match(s.text, /WARN Chrome tab capture[^\n]*\n\s+enable it/);
  assert.match(s.text, /WARN Chrome windows[^\n]*\n\s+keep it uncovered/);
  assert.equal(summarize([{ name: 'ffmpeg', ok: false, detail: 'not found', fix: 'install' }]).allPassed, false);
  assert.match(summarize([{ name: 'ffmpeg', ok: false, detail: 'not found', fix: 'install' }]).text, /^FIX  ffmpeg: not found\n\s+install$/);
});

test('doctor run: the Chrome windows advice names both remedies, and optional items are warnings', async () => {
  const savedCdp = process.env.SCREENREC_CDP;
  delete process.env.SCREENREC_CDP;  // with it set, tab capture would report the env endpoint instead
  let r: { checks: { name: string; ok: boolean; warn?: boolean; fix?: string }[]; text: string };
  try { r = await doctorCommand({ dirs: [] })(args) as typeof r; }
  finally { if (savedCdp !== undefined) process.env.SCREENREC_CDP = savedCdp; }
  if (process.platform === 'darwin') {
    const cw = r.checks.find((c) => c.name === 'Chrome windows')!;
    assert.equal(cw.warn, true);
    assert.match(cw.fix!, /uncovered/); assert.match(cw.fix!, /--disable-backgrounding-occluded-windows/);
    assert.match(r.text, /--disable-backgrounding-occluded-windows/);
  }
  const tab = r.checks.find((c) => c.name === 'Chrome tab capture')!;
  assert.equal(tab.ok, false); assert.equal(tab.warn, true);
});

test('doctor checks ffprobe with the same check start uses', async () => {
  const saved = process.env.SCREENREC_FFPROBE;
  process.env.SCREENREC_FFPROBE = '/nonexistent/ffprobe';
  try {
    const r = await doctorCommand({ dirs: [] })(args) as { checks: { name: string; ok: boolean; fix?: string }[] };
    const c = r.checks.find((x) => x.name === 'ffprobe')!;
    assert.equal(c.ok, false); assert.match(c.fix!, /ffmpeg/);
  } finally { if (saved === undefined) delete process.env.SCREENREC_FFPROBE; else process.env.SCREENREC_FFPROBE = saved; }
});
