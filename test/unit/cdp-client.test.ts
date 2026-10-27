import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../../src/capture/cdp/client.ts';

class FakeWs {
  static last: FakeWs;
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: (e: unknown) => void;
  sent: any[] = [];
  constructor(public url: string) { FakeWs.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(s: string) { const m = JSON.parse(s); this.sent.push(m);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(m.method === 'Bad.method' ? { id: m.id, error: { message: 'nope' } } : { id: m.id, result: { echo: m.method }, sessionId: m.sessionId }) }), 0); }
  close() { this.onclose?.(); }
}

test('send resolves by id, rejects on error, routes events with sessionId', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/devtools/browser/x', FakeWs as unknown as typeof WebSocket);
  assert.deepEqual(await c.send('Target.getTargets'), { echo: 'Target.getTargets' });
  await c.send('Page.enable', {}, 'S1');
  assert.equal(FakeWs.last.sent.at(-1).sessionId, 'S1');
  await assert.rejects(c.send('Bad.method'), /nope/);
  const got: any[] = [];
  c.on('Page.screencastFrame', (p, s) => got.push([p.n, s]));
  FakeWs.last.onmessage!({ data: JSON.stringify({ method: 'Page.screencastFrame', params: { n: 1 }, sessionId: 'S1' }) });
  assert.deepEqual(got, [[1, 'S1']]);
  let closed = false; c.onClose(() => (closed = true)); c.close(); assert.equal(closed, true);
});

test('connect refuses non-loopback URLs before opening a socket', async () => {
  await assert.rejects(CdpClient.connect('ws://8.8.8.8:9222/x', FakeWs as unknown as typeof WebSocket), /loopback/);
});

class SilentWs { onopen?: () => void; constructor(public url: string) {} send() {} close() {} }

test('connect times out with a fix that mentions the Allow dialog', async () => {
  await assert.rejects(CdpClient.connect('ws://127.0.0.1:1/x', SilentWs as unknown as typeof WebSocket, 30),
    (e: any) => e.code === 'E_CDP_UNAVAILABLE' && /Allow/.test(e.fix));
});

test('malformed frames are ignored and a throwing send rejects and clears pending', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/x', FakeWs as unknown as typeof WebSocket);
  assert.doesNotThrow(() => FakeWs.last.onmessage!({ data: 'not json' }));
  FakeWs.last.send = () => { throw new Error('socket closed'); };
  await assert.rejects(c.send('X.y'), /socket closed/);
  assert.equal((c as any).pending.size, 0);
});

test('after the socket closes, send rejects immediately instead of hanging', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/x', FakeWs as unknown as typeof WebSocket);
  c.close();
  await assert.rejects(c.send('Page.stopScreencast'), /CDP connection closed/);
  assert.equal((c as any).pending.size, 0);
});

class MuteWs extends FakeWs {
  send(s: string) { this.sent.push(JSON.parse(s)); }  // never answers
}

test('calls in flight on a session that gets detached are rejected, not left hanging', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/x', MuteWs as unknown as typeof WebSocket);
  const p = c.send('Page.stopScreencast', {}, 'S9');
  const other = c.send('Page.enable', {}, 'S1');
  (MuteWs as any).last.onmessage({ data: JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S9' } }) });
  await assert.rejects(p, /session detached/);
  let settled = false; other.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'other sessions are untouched');
});

test('a per-call timeout rejects an unanswered call and clears pending', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/x', MuteWs as unknown as typeof WebSocket);
  await assert.rejects(c.send('Page.stopScreencast', {}, 'S9', 30), /timed out/);
  assert.equal((c as any).pending.size, 0);
});

class FailWs { onopen?: () => void; onerror?: () => void; constructor(public url: string) { setTimeout(() => this.onerror?.(), 0); } send() {} close() {} }

test('connect errors never show the URL path (a broker token lives there)', async () => {
  const token = 'ab'.repeat(32);
  for (const Impl of [FailWs, SilentWs]) {
    await assert.rejects(CdpClient.connect(`ws://127.0.0.1:4567/${token}`, Impl as unknown as typeof WebSocket, 30), (e: any) => {
      assert.ok(!JSON.stringify({ m: e.message, f: e.fix }).includes(token), e.message);
      assert.match(e.message, /ws:\/\/127\.0\.0\.1:4567\/<redacted>/);
      return true;
    });
  }
});
