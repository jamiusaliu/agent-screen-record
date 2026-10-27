import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, TOOL_NAMES } from '../../src/mcp/server.ts';
import { makeVideo } from '../video/helpers.ts';

type Result = { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
let client: Client; let video = ''; let big = ''; let home = '';
const called = new Set<string>();
before(async () => {
  process.env.SCREENREC_MAC_HELPER = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
  process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
  delete process.env.SCREENREC_CDP; delete process.env.FAKE_HELPER_MODE;
  // A temp HOME: "~/" inputs resolve here, and no real Chrome profile is visible.
  home = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-user-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cwd-')));
  video = path.join(home, 'in.mp4'); await makeVideo(video, 'moving', { seconds: 2 });
  big = path.join(home, 'big.mp4'); await makeVideo(big, 'moving', { seconds: 1, size: '960x540' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: 'test', version: '0.0.0' }); await client.connect(b);
});
const call = (name: string, args: Record<string, unknown> = {}) => { called.add(name); return client.callTool({ name, arguments: args }) as Promise<Result>; };
const json = (r: Result) => JSON.parse(r.content.find((c) => c.type === 'text')!.text!);
const image = (r: Result) => r.content.find((c) => c.type === 'image');
const pngWidth = (b64: string) => Buffer.from(b64, 'base64').readUInt32BE(16);
const previewDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('screenrec-preview-'));
const mac = process.platform === 'darwin';

test('lists exactly the documented tools, each with a description', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools) assert.ok((t.description ?? '').length > 20, t.name);
  const desc = (n: string) => tools.find((t) => t.name === n)!.description!;
  assert.match(desc('record_start'), /tell the user in chat that you are starting/i);
  assert.match(desc('record_stop'), /tell the user in chat that you stopped/i);
  assert.doesNotMatch(JSON.stringify(tools), /\u2014/, 'no em dashes');
});

test('descriptions document cdp needing tab and doctor WARN checks being optional', async () => {
  const { tools } = await client.listTools();
  const props = (n: string) => (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props('record_start').cdp.description!, /only with tab/i);
  assert.match(props('screenshot').cdp.description!, /only with tab/i);
  assert.match(tools.find((t) => t.name === 'doctor')!.description!, /warn.*optional.*allPassed/i);
});

test('advertised schemas keep precise types, required fields and descriptions', async () => {
  const { tools } = await client.listTools();
  const schema = (n: string) => tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, { type?: string; description?: string; enum?: string[]; items?: { type: string } }>; required?: string[] };
  const start = schema('record_start');
  for (const k of ['display_of', 'follow_app', 'ignore_app', 'no_meta', 'tab', 'window']) assert.ok(k in start.properties, k);
  assert.equal(start.properties.follow_app.type, 'boolean');
  assert.deepEqual(start.properties.ignore_app.items, { type: 'string' });
  assert.equal(start.properties.fps.type, 'number');
  assert.deepEqual(schema('video_trim').required, ['input', 'to']);
  assert.equal(schema('video_gif').properties.width.type, 'number');
  const hold = schema('video_squeeze').properties.hold as { type?: string; minimum?: number };
  assert.equal(hold.type, 'number'); assert.equal(hold.minimum, 0);
  assert.match(tools.find((t) => t.name === 'video_squeeze')!.description!, /at most hold seconds.*0 gives the fastest cut/);
  assert.deepEqual(schema('list_targets').properties.kind.enum, ['windows', 'displays', 'tabs']);
  assert.ok('trim_edges' in schema('video_crop').properties);
  assert.match(schema('video_crop').properties.input.description!, /absolute path or ~\//i);
  for (const k of ['display', 'display_of', 'region']) assert.match(start.properties[k].description!, /all other windows.*Focus/i, k);
  assert.match(start.properties.region.description!, /default main/);
  assert.match(start.properties.tab.description!, /created after start/);
  assert.match(tools.find((t) => t.name === 'screenshot')!.description!, /prefer a window or tab/i);
  assert.ok(!JSON.stringify(tools).includes('chrome-broker'), 'chrome-broker is not an MCP tool');
});

test('doctor and list_targets (displays, windows, tabs) work', async () => {
  assert.equal(json(await call('doctor')).ok, true);
  const d = await call('list_targets', { kind: 'displays' });
  const w = await call('list_targets', { kind: 'windows' });
  if (mac) { assert.equal(json(d).displays[0].name, 'Built-in'); assert.equal(json(w).windows[0].app, 'Finder'); }
  else { assert.equal(json(d).code, 'E_UNSUPPORTED_PLATFORM'); assert.equal(json(w).code, 'E_UNSUPPORTED_PLATFORM'); }
  const t = await call('list_targets', { kind: 'tabs' });
  assert.equal(t.isError, true, 'no Chrome is visible under the temp HOME');
  const j = json(t); assert.equal(j.ok, false); assert.equal(j.code, 'E_CDP_UNAVAILABLE'); assert.ok(j.fix);
});

test('video tools run on a real file; frame returns an image; ~/ paths expand', async () => {
  assert.ok(json(await call('video_squeeze', { input: video })).out);
  assert.ok(json(await call('video_squeeze', { input: video, hold: 0, out: '~/sq0.mp4' })).out);
  const neg = await call('video_squeeze', { input: video, hold: -1 });
  assert.equal(neg.isError, true); assert.equal(json(neg).code, 'E_BAD_ARGS'); assert.match(json(neg).message, /hold/);
  assert.ok(json(await call('video_crop', { input: '~/in.mp4', trim_edges: 8, out: '~/crop.mp4' })).out);
  assert.ok(fs.existsSync(path.join(home, 'crop.mp4')), '~/ out expanded with the home directory');
  assert.ok(json(await call('video_blur', { input: video, box: ['10,10,40,40'] })).out);
  assert.ok(json(await call('video_trim', { input: video, from: 0.5, to: 1.5 })).out);
  assert.ok(json(await call('video_gif', { input: video, width: 200 })).out);
  const f = await call('video_frame', { input: video, at: 1, out: '~/f.png' });
  assert.equal(json(f).out, path.join(home, 'f.png'));
  const img = image(f)!; assert.equal(img.mimeType, 'image/png');
  assert.equal(pngWidth(img.data!), 320, 'a 320 px frame is not upscaled');
  assert.equal(pngWidth(image(await call('video_frame', { input: big, at: 0.5 }))!.data!), 480, 'a 960 px frame is scaled to 480');
  assert.deepEqual(previewDirs(), [], 'no preview temp dir left behind');
});

test('errors come back as isError with a code and a fix', async () => {
  const r = await call('video_crop', { input: '/nope.mp4', trim_edges: 8 });
  assert.equal(r.isError, true); const j = json(r); assert.equal(j.code, 'E_BAD_ARGS'); assert.ok(j.fix);
  const s = await call('record_stop');
  assert.equal(s.isError, true); assert.equal(json(s).code, 'E_NOT_RECORDING');
});

test('schema violations give the errorJson shape with E_BAD_ARGS and a fix', async () => {
  for (const [name, args, field] of [
    ['video_trim', { input: video }, 'to'],
    ['video_gif', { input: video, width: 'abc' }, 'width'],
    ['record_start', { window: 'Finder', ignore_app: 'Safari' }, 'ignore_app'],
    ['list_targets', { kind: 'bogus' }, 'kind'],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    const j = json(r);
    assert.deepEqual(Object.keys(j).sort(), ['code', 'fix', 'message', 'ok'], name);
    assert.equal(j.ok, false); assert.equal(j.code, 'E_BAD_ARGS', name);
    assert.match(j.message, new RegExp(field), name); assert.ok(j.fix.length > 10, name);
  }
  assert.equal(json(await call('record_status')).recording, false, 'the bad record_start did not start anything');
});

test('screenshot returns the file and a preview; a broken preview is reported, not fatal (macOS)', { skip: !mac }, async () => {
  const r = await call('screenshot', { window: 'Finder', out: '~/shot.png' });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(json(r).out, path.join(home, 'shot.png'));
  assert.ok(fs.existsSync(path.join(home, 'shot.png')));
  assert.equal(pngWidth(image(r)!.data!), 320);
  process.env.FAKE_HELPER_MODE = 'bad-png';
  try {
    const b = await call('screenshot', { window: 'Finder', out: '~/bad.png' });
    assert.equal(b.isError, undefined); assert.equal(image(b), undefined);
    assert.equal(json(b).ok, true); assert.ok(json(b).previewError, 'previewError explains the missing image');
  } finally { delete process.env.FAKE_HELPER_MODE; }
  assert.deepEqual(previewDirs(), []);
});

test('record_start, record_mark, record_status, record_stop with a preview image (macOS)', { skip: !mac }, async () => {
  assert.equal(json(await call('record_start', { window: 'Finder' })).worker, 'mac');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(json(await call('record_mark', { text: '-starts with a dash' })).ok, true);
  assert.equal(json(await call('record_status')).recording, true);
  const stop = await call('record_stop');
  const out = json(stop).out as string;
  assert.ok(out.endsWith('.mp4'));
  assert.equal(pngWidth(image(stop)!.data!), 320, 'preview of a 320 px recording is not upscaled');
  assert.deepEqual(previewDirs(), []);
  assert.equal(json(await call('record_status')).recording, false);
});

test('mid-recording: screenshot is answered by the recorder; status and stop report a lock (macOS)', { skip: !mac }, async () => {
  const started = json(await call('record_start', { window: 'Finder', out: '~/locked.mp4' }));
  const base = (started.out as string).replace(/\.mp4$/, '');
  const requests = path.join(process.env.SCREENREC_HOME!, 'requests');
  try {
    // the recorder takes the screenshot itself: a second helper process quitting would stop its stream
    const shot = json(await call('screenshot', { window: 'Finder', out: '~/mid.png' }));
    assert.equal(shot.ok, true, JSON.stringify(shot)); assert.equal(shot.served, true, 'answered by the running recorder');
    assert.equal(shot.out, path.join(home, 'mid.png')); assert.ok(fs.existsSync(shot.out));
    assert.deepEqual(fs.readdirSync(requests), [], 'the PNG was moved out of the request folder');
    // an existing out is still refused without force, although the recorder never sees that path
    const taken = json(await call('screenshot', { window: 'Finder', out: '~/mid.png' }));
    assert.equal(taken.code, 'E_BAD_ARGS'); assert.match(taken.message, /already exists/);
    // an agent's own step note with the same words is not a lock
    assert.equal(json(await call('record_mark', { text: 'screen locked' })).ok, true);
    // what the helper writes when the screen locks: a screen event (with t) in the log, a mark on the recording clock
    const t = (Date.now() - JSON.parse(fs.readFileSync(path.join(process.env.SCREENREC_HOME!, 'state.json'), 'utf8')).startedAt) / 1000;
    fs.appendFileSync(`${base}.rec.log`, JSON.stringify({ event: 'screen', state: 'locked', t }) + '\n');
    fs.appendFileSync(`${base}.marks.jsonl`, JSON.stringify({ t, text: 'screen locked' }) + '\n');
    const st = json(await call('record_status'));
    assert.equal(st.screen, 'locked'); assert.match(st.text, /warning: the screen is locked: nothing is being captured/);
    process.env.FAKE_SCREEN = 'locked';
    const refused = json(await call('screenshot', { window: 'Finder', out: '~/refused.png' }));
    assert.equal(refused.code, 'E_NO_FRAMES'); assert.match(refused.message, /screenshot not taken: the screen is locked/); assert.match(refused.fix, /^Unlock the Mac/);
    delete process.env.FAKE_SCREEN;
    await new Promise((r) => setTimeout(r, 2200));
    fs.appendFileSync(`${base}.rec.log`, JSON.stringify({ event: 'screen', state: 'awake', t: t + 2 }) + '\n');
    fs.appendFileSync(`${base}.marks.jsonl`, JSON.stringify({ t: t + 2, text: 'screen unlocked' }) + '\n');
    assert.equal(json(await call('record_status')).screen, undefined, 'no screen field once it is drawn again');
    await new Promise((r) => setTimeout(r, 300));
  } finally { delete process.env.FAKE_SCREEN; }
  const stop = json(await call('record_stop'));
  assert.equal(stop.warnings?.length, 1, JSON.stringify(stop));
  assert.match(stop.warnings[0], /^the screen was locked for 2s \(\d:\d\d to \d:\d\d in the video\); that part of the video is frozen or blank$/);
  assert.match(stop.text, /\nwarning: the screen was locked/);
  const marks = JSON.parse(fs.readFileSync(stop.sidecar, 'utf8')).marks.map((m: { text: string }) => m.text);
  assert.deepEqual(marks, ['screen locked', 'screen locked', 'screen unlocked'], 'the agent note and the two helper marks');
});

test('force: every tool with out advertises a boolean force; an existing out is refused unless force is true', async () => {
  const { tools } = await client.listTools();
  for (const n of ['record_start', 'screenshot', 'video_squeeze', 'video_crop', 'video_blur', 'video_trim', 'video_gif', 'video_frame']) {
    const p = (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
    assert.equal(p.force?.type, 'boolean', n); assert.match(p.force.description!, /replace/i, n);
    assert.match(p.out.description!, /force/, n);
  }
  const taken = path.join(home, 'taken.mp4'); fs.writeFileSync(taken, 'mine');
  const r = await call('video_trim', { input: video, from: 0.5, to: 1.5, out: '~/taken.mp4' });
  assert.equal(r.isError, true); const j = json(r);
  assert.deepEqual(Object.keys(j).sort(), ['code', 'fix', 'message', 'ok']);
  assert.equal(j.code, 'E_BAD_ARGS'); assert.ok(j.message.includes(taken)); assert.match(j.fix, /force: true/);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'mine');
  const bad = await call('video_trim', { input: video, from: 0.5, to: 1.5, out: '~/taken.mp4', force: 'yes' });
  assert.equal(bad.isError, true); assert.match(json(bad).message, /force/);
  const ok = await call('video_trim', { input: video, from: 0.5, to: 1.5, out: '~/taken.mp4', force: true });
  assert.equal(ok.isError, undefined, JSON.stringify(ok)); assert.equal(json(ok).out, taken);
  assert.notEqual(fs.readFileSync(taken, 'utf8'), 'mine');
  const same = await call('video_trim', { input: video, from: 0.5, to: 1.5, out: video, force: true });
  assert.equal(same.isError, true); assert.match(json(same).message, /same file as the input/);
});

test('force without out is refused in MCP with the fix text', async () => {
  for (const [name, args] of [
    ['video_trim', { input: video, from: 0.5, to: 1.5, force: true }],
    ['video_gif', { input: video, force: true }],
    ['screenshot', { tab: 'url:example', force: true }],
    ['record_start', { window: 'Finder', force: true }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name); const j = json(r);
    assert.equal(j.code, 'E_BAD_ARGS', name); assert.equal(j.fix, '--force only applies with --out.', name);
  }
  assert.equal(json(await call('record_status')).recording, false);
});

test('every tool was called by this file (spec 10.4)', { skip: !mac }, () => {
  assert.deepEqual([...TOOL_NAMES].filter((n) => !called.has(n)), []);
});

test('a server whose cwd is / writes default outputs to ~/Movies/screenrec, and clean-up keeps derived names next to a writable input (macOS)', { skip: !mac }, async () => {
  const before = process.cwd();
  const movies = path.join(home, 'Movies', 'screenrec');
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ro-'));
  fs.copyFileSync(video, path.join(ro, 'locked-in.mp4')); fs.chmodSync(ro, 0o555);
  process.chdir('/');
  try {
    const shot = json(await call('screenshot', { window: 'Finder' }));
    assert.equal(path.dirname(shot.out), movies, JSON.stringify(shot));
    const started = json(await call('record_start', { window: 'Finder' }));
    assert.equal(path.dirname(started.out), movies, JSON.stringify(started));
    await new Promise((r) => setTimeout(r, 300));
    const stopped = json(await call('record_stop'));
    assert.equal(path.dirname(stopped.out), movies, JSON.stringify(stopped));
    const nextTo = json(await call('video_trim', { input: video, from: 0, to: 1 }));
    assert.equal(path.dirname(nextTo.out), home, 'a writable input folder keeps the derived name next to it');
    assert.match(path.basename(nextTo.out), /^in\.trim(-\d+)?\.mp4$/);
    const moved = json(await call('video_trim', { input: path.join(ro, 'locked-in.mp4'), from: 0, to: 1 }));
    assert.equal(moved.out, path.join(movies, 'locked-in.trim.mp4'), 'an unwritable input folder falls back to the default folder');
    assert.ok(!fs.existsSync('/recordings'));
  } finally { process.chdir(before); fs.chmodSync(ro, 0o755); fs.rmSync(ro, { recursive: true, force: true }); }
});
