import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pidExists, safeKill } from '../../src/core/platform.ts';
import { realDeps } from '../../src/recorder.ts';
import { stopBroker } from '../../src/capture/cdp/broker-client.ts';

/** Records process.kill calls instead of sending anything. */
function spyKill<T>(fn: () => T): { calls: unknown[][]; result: T } {
  const real = process.kill;
  const calls: unknown[][] = [];
  (process as { kill: unknown }).kill = (...a: unknown[]) => { calls.push(a); return true; };
  try { return { calls, result: fn() }; } finally { process.kill = real; }
}

test('no signal is ever sent to pid 1, 0, a negative pid or a non-integer (kill(-1) would hit every user process)', () => {
  for (const pid of [1, 0, -1, -42, 1.5, NaN]) {
    for (const sig of ['SIGINT', 'SIGKILL'] as const) {
      assert.deepEqual(spyKill(() => realDeps.signal(pid, sig)).calls, [], `recorder signal ${pid} ${sig}`);
      assert.deepEqual(spyKill(() => safeKill(pid, sig)).calls, [], `safeKill ${pid} ${sig}`);
    }
    assert.equal(pidExists(pid), false, `pidExists ${pid}`);
  }
  assert.deepEqual(spyKill(() => realDeps.signal(4242, 'SIGKILL')).calls, [[-4242, 'SIGKILL']], 'a real pid still gets its group');
});

test('stopBroker never signals pid 1 even if its info file says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kill1-'));
  try {
    const infoPath = path.join(dir, 'chrome-broker.json');
    fs.writeFileSync(infoPath, JSON.stringify({ pid: 1, port: 5000, token: 'a'.repeat(64), upstream: 'ws://127.0.0.1:9222/devtools/browser/x', startedAt: 0 }));
    let n = 0;
    const real = process.kill; const calls: unknown[][] = [];
    (process as { kill: unknown }).kill = (...a: unknown[]) => { calls.push(a); return true; };
    try { await stopBroker({ infoPath, alive: () => n++ < 1 }); } finally { process.kill = real; }
    assert.deepEqual(calls, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
