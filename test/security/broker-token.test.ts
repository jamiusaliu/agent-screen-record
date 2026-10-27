// The broker token is a secret: `ps` shows every user's argv on macOS and loopback is shared,
// so it must never appear in a process command line or in an error message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startRecording, realDeps, type RecorderDeps } from '../../src/recorder.ts';
import { readState } from '../../src/core/state.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cmdline = (pid: number) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const children = (pid: number) => { try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };

test('the tab worker and its supervisor never carry the broker token in argv, and a connect failure hides it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-tok-')); const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-tok-'));
  const prevHome = process.env.SCREENREC_HOME; process.env.SCREENREC_HOME = home;
  // a "broker" that accepts TCP and never answers the WebSocket handshake, so the worker waits connected
  const held: net.Socket[] = [];
  const srv = net.createServer((s) => { held.push(s); s.on('error', () => {}); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  const token = crypto.randomBytes(32).toString('hex');
  const deps: RecorderDeps = { ...realDeps, cdp: { ...realDeps.cdp, resolveEndpoint: async () => ({ wsUrl: `ws://127.0.0.1:${port}/${token}` }) } };
  try {
    const run = startRecording({ target: { kind: 'tab', mode: 'newest' }, fps: 30, cursor: false, maxMs: 60_000, meta: false, cwd }, deps);
    run.catch(() => {});
    // up to 30 s: under heavy load a tsx worker can take longer than 5 s to start
    for (let i = 0; i < 1200 && held.length === 0; i++) await sleep(25);
    assert.ok(held.length > 0, 'the worker connected, so it has its config');
    const sup = readState()!.pid;
    const pids = [sup, ...children(sup)];
    assert.ok(pids.length >= 2, `supervisor and worker: ${pids}`);
    for (const pid of pids) {
      const c = cmdline(pid);
      assert.ok(c.length > 0, `ps shows ${pid}`);
      assert.doesNotMatch(c, /[0-9a-f]{64}/, `argv of ${pid}: ${c}`);
    }
    for (const s of held) s.destroy();
    await assert.rejects(run, (e: ScreenrecError) => {
      const all = JSON.stringify({ m: e.message, f: e.fix });
      assert.ok(!all.includes(token), all);
      assert.match(e.message, /<redacted>/);
      return true;
    });
  } finally {
    srv.close(); for (const s of held) s.destroy();
    if (prevHome === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prevHome;
    for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true });
  }
});
