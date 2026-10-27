import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeFrame, FrameReader, WsError, createWsServer, OP } from '../../src/capture/cdp/ws-server.ts';

type Got = { kind: 'message' | 'ping' | 'pong' | 'close'; data: Buffer };
function reader(o: { requireMask?: boolean; maxPayload?: number } = {}) {
  const got: Got[] = [];
  const r = new FrameReader({ requireMask: o.requireMask ?? false, maxPayload: o.maxPayload ?? 256 * 1024 * 1024 },
    (kind, data) => got.push({ kind, data }));
  return { r, got };
}

test('round trip: unmasked server text frame', () => {
  const { r, got } = reader();
  r.feed(encodeFrame(OP.TEXT, Buffer.from('{"id":1}')));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'message');
  assert.equal(got[0].data.toString(), '{"id":1}');
});

test('masked client frames are unmasked; an unmasked frame is refused when masking is required', () => {
  const { r, got } = reader({ requireMask: true });
  const f = encodeFrame(OP.TEXT, Buffer.from('héllo'), { mask: crypto.randomBytes(4) });
  assert.equal(f[1] & 0x80, 0x80);
  assert.notDeepEqual(f.subarray(6), Buffer.from('héllo'));
  r.feed(f);
  assert.equal(got[0].data.toString(), 'héllo');
  assert.throws(() => reader({ requireMask: true }).r.feed(encodeFrame(OP.TEXT, Buffer.from('x'))), (e: WsError) => e.code === 1002);
});

test('payload length forms: 7-bit, 16-bit (126) and 64-bit (127)', () => {
  for (const [len, hdr] of [[125, 2], [126, 4], [65535, 4], [65536, 10], [3 * 1024 * 1024, 10]] as const) {
    const payload = Buffer.alloc(len, 0x61);
    const f = encodeFrame(OP.TEXT, payload);
    assert.equal(f.length, len + hdr, `header for ${len}`);
    if (hdr === 4) assert.equal(f[1] & 0x7f, 126);
    if (hdr === 10) assert.equal(f[1] & 0x7f, 127);
    const masked = encodeFrame(OP.TEXT, payload, { mask: crypto.randomBytes(4) });
    assert.equal(masked.length, len + hdr + 4);
    const { r, got } = reader();
    r.feed(f); r.feed(masked);
    assert.equal(got.length, 2);
    assert.equal(got[0].data.length, len); assert.ok(got[1].data.equals(payload));
  }
});

test('frames split at every byte boundary still decode', () => {
  const a = encodeFrame(OP.TEXT, Buffer.alloc(300, 0x62), { mask: Buffer.from([1, 2, 3, 4]) });
  const b = encodeFrame(OP.TEXT, Buffer.from('second'));
  const all = Buffer.concat([a, b]);
  const { r, got } = reader();
  for (let i = 0; i < all.length; i++) r.feed(all.subarray(i, i + 1));
  assert.deepEqual(got.map((g) => g.data.length), [300, 6]);
});

test('fragmented messages are reassembled, with control frames allowed in between', () => {
  const { r, got } = reader();
  r.feed(Buffer.concat([
    encodeFrame(OP.TEXT, Buffer.from('{"a":'), { fin: false }),
    encodeFrame(OP.PING, Buffer.from('p')),
    encodeFrame(OP.CONT, Buffer.from('12'), { fin: false }),
    encodeFrame(OP.CONT, Buffer.from('3}')),
  ]));
  assert.deepEqual(got.map((g) => [g.kind, g.data.toString()]), [['ping', 'p'], ['message', '{"a":123}']]);
});

test('protocol errors: continuation without a start, fragmented control frame, reserved bits', () => {
  assert.throws(() => reader().r.feed(encodeFrame(OP.CONT, Buffer.from('x'))), (e: WsError) => e.code === 1002);
  assert.throws(() => reader().r.feed(encodeFrame(OP.PING, Buffer.from('x'), { fin: false })), (e: WsError) => e.code === 1002);
  const f = encodeFrame(OP.TEXT, Buffer.from('x')); f[0] |= 0x40;
  assert.throws(() => reader().r.feed(f), (e: WsError) => e.code === 1002);
});

test('a message above maxPayload is refused with 1009 from its header alone', () => {
  const big = Buffer.from([0x81, 127, 0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]);  // declares about 2 GB, no payload sent
  assert.throws(() => reader().r.feed(big), (e: WsError) => e.code === 1009);
  const { r } = reader({ maxPayload: 10 });
  r.feed(encodeFrame(OP.TEXT, Buffer.alloc(6), { fin: false }));
  assert.throws(() => r.feed(encodeFrame(OP.CONT, Buffer.alloc(6))), (e: WsError) => e.code === 1009);
});

async function rawUpgrade(port: number, pathName: string, headers: Record<string, string> = {}): Promise<{ sock: net.Socket; head: string }> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  const key = crypto.randomBytes(16).toString('base64');
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  sock.write(`GET ${pathName} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
  const head = await new Promise<string>((r) => sock.once('data', (d) => r(String(d))));
  return { sock, head };
}

test('server: handshake, echo, ping/pong, close handshake; Node WebSocket client interoperates', async () => {
  const srv = await createWsServer({
    onConnection: (conn) => { conn.onMessage((m) => conn.send(`echo:${m}`)); },
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/x`);
    await new Promise((r) => { ws.onopen = r; });
    const big = 'x'.repeat(5 * 1024 * 1024);
    const reply = new Promise<string>((r) => { ws.onmessage = (e) => r(String(e.data)); });
    ws.send(big);
    assert.equal((await reply).length, big.length + 5);
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    ws.close(1000);
    assert.equal(await closed, 1000);

    const { sock, head } = await rawUpgrade(srv.port, '/y');
    assert.match(head, /^HTTP\/1\.1 101/);
    assert.doesNotMatch(head, /permessage-deflate/i);
    const frames: Buffer[] = [];
    sock.on('data', (d) => frames.push(d));
    sock.write(encodeFrame(OP.PING, Buffer.from('hi'), { mask: crypto.randomBytes(4) }));
    await new Promise((r) => setTimeout(r, 100));
    const got: Got[] = [];
    new FrameReader({ requireMask: false, maxPayload: 1e6 }, (kind, data) => got.push({ kind, data })).feed(Buffer.concat(frames));
    assert.deepEqual(got.map((g) => [g.kind, g.data.toString()]), [['pong', 'hi']]);
    sock.destroy();
  } finally { await srv.close(); }
});

test('server: verify can refuse an upgrade with an HTTP status; an oversized message closes with 1009', async () => {
  const srv = await createWsServer({
    maxPayload: 1024,
    verify: (req) => (req.headers.origin ? 403 : null),
    onConnection: () => {},
  });
  try {
    const { sock, head } = await rawUpgrade(srv.port, '/z', { Origin: 'https://evil.example' });
    assert.match(head, /^HTTP\/1\.1 403/);
    sock.destroy();
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/z`);
    await new Promise((r) => { ws.onopen = r; });
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    ws.send('y'.repeat(2048));
    assert.equal(await closed, 1009);
  } finally { await srv.close(); }
});

test('a continuation frame that would exceed the cap is refused from its header alone', () => {
  const { r } = reader({ maxPayload: 10 });
  r.feed(encodeFrame(OP.TEXT, Buffer.alloc(6), { fin: false }));
  const hdrOnly = encodeFrame(OP.CONT, Buffer.alloc(6)).subarray(0, 2);  // no payload bytes yet
  assert.throws(() => r.feed(hdrOnly), (e: WsError) => e.code === 1009);
});

test('after a protocol failure no further frames from the same chunk are dispatched', async () => {
  const { Duplex } = await import('node:stream');
  const { WsConnection } = await import('../../src/capture/cdp/ws-server.ts');
  const written: Buffer[] = [];
  const sock = new Duplex({ read() {}, write(c, _e, cb) { written.push(c); cb(); } });
  const conn = new WsConnection(sock, 1e6);
  const got: string[] = []; let code = 0;
  conn.onMessage((m) => got.push(m)); conn.onClose((c) => { code = c; });
  const mask = Buffer.from([9, 8, 7, 6]);
  sock.push(Buffer.concat([
    encodeFrame(OP.TEXT, Buffer.from('first'), { mask }),
    encodeFrame(OP.TEXT, Buffer.from([0xff, 0xfe]), { mask }),   // invalid UTF-8: 1007
    encodeFrame(OP.TEXT, Buffer.from('after-failure'), { mask }),
  ]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['first']);
  assert.equal(code, 1007);
});
