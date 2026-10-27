import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, parseDuration } from '../../src/cli/args.ts';
import { main } from '../../src/cli/main.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const capture = () => { const out: string[] = []; const err: string[] = []; return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err }; };

test('parseCli handles flags, repeats and positionals', () => {
  const a = parseCli(['start', '--window', 'Finder:Downloads', '--ignore-app', 'Orca', '--ignore-app', 'Code', '--follow-app', '--json']);
  assert.equal(a.command, 'start');
  assert.equal(a.values.window, 'Finder:Downloads');
  assert.deepEqual(a.values['ignore-app'], ['Orca', 'Code']);
  assert.equal(a.values['follow-app'], true);
  assert.equal(a.json, true);
  assert.deepEqual(parseCli(['mark', 'clicked Download']).positionals, ['clicked Download']);
});

test('unknown command or flag is E_BAD_ARGS', () => {
  assert.throws(() => parseCli(['explode']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseCli(['start', '--windwo', 'x']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('parseDuration', () => {
  assert.equal(parseDuration('10m'), 600000); assert.equal(parseDuration('90s'), 90000); assert.equal(parseDuration('600'), 600000);
  assert.throws(() => parseDuration('soon'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('main prints JSON success and returns 0', async () => {
  const c = capture();
  assert.equal(await main(['version', '--json'], c.io), 0);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.ok, true); assert.match(j.version, /^\d+\.\d+\.\d+/);
});

test('main prints JSON errors with code and fix, returns 1', async () => {
  const c = capture();
  assert.equal(await main(['explode', '--json'], c.io), 1);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.ok, false); assert.equal(j.code, 'E_BAD_ARGS'); assert.ok(j.fix.length > 0);
});

test('main prints human text without --json', async () => {
  const c = capture();
  assert.equal(await main(['version'], c.io), 0);
  assert.match(c.out.join(''), /screenrec \d+\.\d+\.\d+/);
});

test('--help lists flags, returns 0 and never loads the command module', async () => {
  const c = capture();
  assert.equal(await main(['stop', '--help'], c.io), 0); // stop has no module yet: would fail if dispatched
  assert.match(c.out.join(''), /Usage: screenrec stop/);
  const s = capture();
  assert.equal(await main(['start', '--help'], s.io), 0);
  assert.match(s.out.join(''), /--window/); assert.match(s.out.join(''), /--ignore-app/);
  const j = capture();
  assert.equal(await main(['start', '--json', '--help'], j.io), 0);
  const o = JSON.parse(j.out.join(''));
  assert.equal(o.ok, true); assert.equal(o.command, 'start'); assert.ok(o.flags.includes('window'));
});

test('--help and help with no command list the commands', async () => {
  for (const argv of [['--help'], ['help'], ['-h']]) {
    const c = capture();
    assert.equal(await main(argv, c.io), 0);
    assert.match(c.out.join(''), /version/); assert.match(c.out.join(''), /squeeze/);
  }
});

test('a command with no module is a clear E_BAD_ARGS, not a crash', async () => {
  const c = capture();
  const absent = async (spec: string) => { throw Object.assign(new Error(`Cannot find module '/x/commands/doctor.js' imported from ${spec}`), { code: 'ERR_MODULE_NOT_FOUND' }); };
  assert.equal(await main(['doctor', '--json'], c.io, absent), 1);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.code, 'E_BAD_ARGS'); assert.match(j.message, /not available in this build/);
});

test('a real error inside a command module is not swallowed by the .ts fallback', async () => {
  const c = capture();
  const broken = async () => { throw Object.assign(new Error("Cannot find module 'left-pad' imported from x/util.js"), { code: 'ERR_MODULE_NOT_FOUND' }); };
  assert.equal(await main(['doctor', '--json'], c.io, broken), 1);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.code, 'E_HELPER_CRASHED'); assert.match(j.message, /left-pad/);
});

test('free text starting with a dash needs -- and the error says so', () => {
  assert.deepEqual(parseCli(['mark', '--', '- note']).positionals, ['- note']);
  assert.deepEqual(parseCli(['mark', '--', '-x']).positionals, ['-x']);
  assert.throws(() => parseCli(['mark', '-x']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && /--/.test(e.fix) && /mark -- /.test(e.fix));
});

test('chrome-broker status|stop: parsed, never prints the token, bad subcommand is E_BAD_ARGS', async () => {
  const { chromeBrokerCommand } = await import('../../src/commands/chrome-broker.ts');
  assert.deepEqual(parseCli(['chrome-broker', 'status', '--json']).positionals, ['status']);
  const info = { pid: 321, port: 50111, token: 'f'.repeat(64), upstream: 'ws://127.0.0.1:9222/devtools/browser/abc', startedAt: Date.parse('2026-10-17T10:00:00Z') };
  let stopped = 0;
  const cmd = chromeBrokerCommand({ status: () => info, stop: async () => { stopped++; return true; } });
  const a = (sub: string[]) => ({ command: 'chrome-broker', positionals: sub, values: {}, json: true });
  const s = await cmd(a(['status']));
  assert.equal(s.ok, true); assert.equal(s.running, true); assert.equal(s.pid, 321); assert.equal(s.port, 50111);
  assert.doesNotMatch(JSON.stringify(s), /f{64}/);
  assert.match(s.text, /running/); assert.match(s.text, /321/);
  const t = await cmd(a(['stop']));
  assert.equal(t.stopped, true); assert.equal(stopped, 1);
  const idle = chromeBrokerCommand({ status: () => null, stop: async () => false });
  assert.equal((await idle(a(['status']))).running, false);
  assert.match((await idle(a(['stop']))).text, /not running/);
  for (const bad of [[], ['restart']]) await assert.rejects(cmd(a(bad)), (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && /status\|stop/.test(e.fix));
});

test('main: chrome-broker status --json with an empty SCREENREC_HOME reports not running', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const prev = process.env.SCREENREC_HOME;
  process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-'));
  try {
    const c = capture();
    assert.equal(await main(['chrome-broker', 'status', '--json'], c.io), 0);
    const j = JSON.parse(c.out.join(''));
    assert.equal(j.ok, true); assert.equal(j.running, false);
  } finally { if (prev === undefined) delete process.env.SCREENREC_HOME; else process.env.SCREENREC_HOME = prev; }
});

test('Allow wait notice: one stderr line in text mode, a warning in JSON mode', async () => {
  const { allowWaitReporter, ALLOW_WAIT_TEXT } = await import('../../src/commands/types.ts');
  assert.equal(ALLOW_WAIT_TEXT, 'Waiting for you to click Allow in Chrome...');
  const err: string[] = []; const w1: string[] = [];
  allowWaitReporter({ command: 'start', positionals: [], values: {}, json: false }, w1, (s) => err.push(s))();
  assert.deepEqual(err, [`${ALLOW_WAIT_TEXT}\n`]); assert.deepEqual(w1, []);
  const w2: string[] = [];
  allowWaitReporter({ command: 'start', positionals: [], values: {}, json: true }, w2, (s) => err.push(s))();
  assert.deepEqual(w2, [ALLOW_WAIT_TEXT]); assert.equal(err.length, 1);
});

test('doctor broker line: running or not, upstream redacted, idle timeout, never the token', async () => {
  const { brokerDoctorCheck } = await import('../../src/commands/chrome-broker.ts');
  const token = 'c'.repeat(64);
  const on = brokerDoctorCheck({ pid: 9, port: 50111, token, upstream: 'ws://127.0.0.1:9222/devtools/browser/uuid-1', startedAt: 0, idleMs: 1_800_000 }, 1_800_000);
  assert.equal(on.ok, true); assert.equal(on.name, 'Chrome broker');
  assert.match(on.detail, /running/); assert.match(on.detail, /ws:\/\/127\.0\.0\.1:9222\/<redacted>/); assert.match(on.detail, /idle timeout 30 min/);
  assert.doesNotMatch(JSON.stringify(on), new RegExp(`${token}|uuid-1`));
  const off = brokerDoctorCheck(null, 600_000);
  assert.equal(off.ok, true); assert.match(off.detail, /not running/); assert.match(off.detail, /idle timeout 10 min/);
});

test('screenshot --tab passes onWaiting so the Allow notice is shown', async () => {
  const { screenshotCommand } = await import('../../src/commands/screenshot.ts');
  const { ALLOW_WAIT_TEXT } = await import('../../src/commands/types.ts');
  const err: string[] = [];
  const cmd = screenshotCommand({
    resolveEndpoint: async (o) => { o.onWaiting?.(); throw new ScreenrecError('E_CDP_UNAVAILABLE', 'no Chrome', 'fix'); },
    err: (s) => err.push(s),
  });
  await assert.rejects(cmd({ command: 'screenshot', positionals: [], values: { tab: 'url:example', out: '/tmp/x.png' }, json: false }),
    (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
  assert.deepEqual(err, [`${ALLOW_WAIT_TEXT}\n`]);
});

test('--force is a boolean flag on every command that takes --out', () => {
  for (const cmd of ['start', 'screenshot', 'squeeze', 'crop', 'blur', 'trim', 'gif', 'frame']) {
    assert.equal(parseCli([cmd, '--force']).values.force, true, cmd);
  }
  assert.throws(() => parseCli(['stop', '--force']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS', 'commands without --out do not take it');
});

test('CLI: an existing --out is refused with the path and the --force fix; the file is untouched', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-'));
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    const taken = path.join(dir, 'taken.mp4'); fs.writeFileSync(taken, 'mine');
    for (const argv of [
      ['squeeze', input], ['crop', input, '--trim-edges', '8'], ['blur', input, '--box', '0,0,8,8'],
      ['trim', input, '--to', '1'], ['gif', input], ['frame', input, '--at', '0'],
    ]) {
      const c = capture();
      assert.equal(await main([...argv, '--out', taken, '--json'], c.io), 1, argv[0]);
      const j = JSON.parse(c.out.join(''));
      assert.equal(j.code, 'E_BAD_ARGS', argv[0]); assert.ok(j.message.includes(taken), argv[0]);
      assert.match(j.fix, /^Choose a different --out path, add --force to replace it, or omit --out to get a new name\./, argv[0]);
    }
    assert.equal(fs.readFileSync(taken, 'utf8'), 'mine');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --force still refuses --out equal to the input', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-'));
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    for (const argv of [['squeeze', input], ['crop', input, '--trim-edges', '8'], ['trim', input, '--to', '1'], ['gif', input]]) {
      const c = capture();
      assert.equal(await main([...argv, '--out', input, '--force', '--json'], c.io), 1, argv[0]);
      const j = JSON.parse(c.out.join(''));
      assert.equal(j.code, 'E_BAD_ARGS'); assert.match(j.message, /same file as the input/, argv[0]);
    }
    assert.equal(fs.readFileSync(input, 'utf8'), 'precious');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('screenshot refuses an existing --out before touching Chrome; --force lets it through', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { screenshotCommand } = await import('../../src/commands/screenshot.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-shot-'));
  try {
    const out = path.join(dir, 'shot.png'); fs.writeFileSync(out, 'mine');
    let asked = 0;
    const cmd = screenshotCommand({ resolveEndpoint: async () => { asked++; throw new ScreenrecError('E_CDP_UNAVAILABLE', 'no Chrome', 'fix'); } });
    await assert.rejects(cmd({ command: 'screenshot', positionals: [], values: { tab: 'url:example', out }, json: true }),
      (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.message.includes(out) && /--force/.test(e.fix));
    assert.equal(asked, 0, 'refused before connecting');
    await assert.rejects(cmd({ command: 'screenshot', positionals: [], values: { tab: 'url:example', out, force: true }, json: true }),
      (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
    assert.equal(asked, 1);
    assert.equal(fs.readFileSync(out, 'utf8'), 'mine');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --force without --out is refused with the fix text, before any work', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { screenshotCommand } = await import('../../src/commands/screenshot.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-force-'));
  try {
    const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'precious');
    for (const argv of [
      ['squeeze', input], ['crop', input, '--trim-edges', '8'], ['blur', input, '--box', '0,0,8,8'],
      ['trim', input, '--to', '1'], ['gif', input], ['frame', input, '--at', '0'],
    ]) {
      const c = capture();
      assert.equal(await main([...argv, '--force', '--json'], c.io), 1, argv[0]);
      const j = JSON.parse(c.out.join(''));
      assert.equal(j.code, 'E_BAD_ARGS', argv[0]); assert.equal(j.fix, '--force only applies with --out.', argv[0]);
    }
    assert.deepEqual(fs.readdirSync(dir), ['in.mp4']);
    let asked = 0;
    const cmd = screenshotCommand({ resolveEndpoint: async () => { asked++; throw new ScreenrecError('E_CDP_UNAVAILABLE', 'no Chrome', 'fix'); } });
    await assert.rejects(cmd({ command: 'screenshot', positionals: [], values: { tab: 'url:example', force: true }, json: true }),
      (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.fix === '--force only applies with --out.');
    assert.equal(asked, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('screenshot --out into a missing folder is a clear E_BAD_ARGS naming the folder, before any capture', async () => {
  const os = await import('node:os'); const path = await import('node:path');
  const missing = path.join(os.tmpdir(), `screenrec-no-such-dir-${process.pid}-${Date.now()}`);
  const out: string[] = [];
  const code = await main(['screenshot', '--display', 'main', '--out', path.join(missing, 'a.png'), '--json'], { out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 1);
  const j = JSON.parse(out.join(''));
  assert.equal(j.code, 'E_BAD_ARGS');
  assert.equal(j.message, `folder does not exist: ${missing}`);
  assert.equal(j.fix, 'Create the folder first or choose another --out.');
});
