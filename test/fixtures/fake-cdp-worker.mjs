#!/usr/bin/env node
// Mimics src/capture/cdp/worker.ts startup for tests. argv[2]: ready | ready-late | fails | hang
const mode = process.argv[2] ?? 'ready';
if (mode === 'fails') {
  process.stderr.write(JSON.stringify({ ok: false, code: 'E_CDP_UNAVAILABLE', message: 'Chrome did not accept the connection',
    fix: 'Click Allow in the Chrome dialog that asks about remote debugging, then try again.' }) + '\n');
  process.exit(1);
}
const keep = setInterval(() => {}, 1000);
process.on('SIGINT', () => { clearInterval(keep); process.exit(0); });
if (mode === 'ready') process.stdout.write('ready\n');
if (mode === 'ready-late') setTimeout(() => process.stdout.write('ready\n'), 1200);
