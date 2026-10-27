// Runs one recorder process and appends its exit status to the log, so a later "screenrec stop"
// (a different process) can tell a clean stop from "no frames" (exit 5) or "writer failed" (exit 6).
// It also stamps a {"event":"first-frame"} line that has no "ms" with the time it was seen, so marks
// can be timed from the first frame of the video.
// Usage: node supervisor.js [--stdin] <logFile> <exe> [args...]. SIGINT and SIGTERM are forwarded to the recorder.
// With --stdin, our stdin is piped to the recorder (it carries the config, which may hold a secret).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const forwardStdin = argv[0] === '--stdin';
const [logFile, exe, ...args] = forwardStdin ? argv.slice(1) : argv;
const fd = fs.openSync(logFile, 'a');
const write = (s: string) => { try { fs.writeSync(fd, s + '\n'); } catch { /* log gone */ } };

function stamp(line: string): string {
  if (!line.startsWith('{')) return line;
  try {
    const j = JSON.parse(line) as { event?: string; ms?: unknown };
    if (j.event === 'first-frame' && typeof j.ms !== 'number') return JSON.stringify({ ...j, ms: Date.now() });
  } catch { /* not JSON */ }
  return line;
}

const child = spawn(exe, args, { stdio: [forwardStdin ? 'pipe' : 'ignore', 'pipe', fd] });
if (forwardStdin) { child.stdin!.on('error', () => {}); process.stdin.pipe(child.stdin!); }
let pending = '';
child.stdout!.on('data', (d: Buffer) => {
  pending += String(d);
  for (let i = pending.indexOf('\n'); i !== -1; i = pending.indexOf('\n')) { write(stamp(pending.slice(0, i))); pending = pending.slice(i + 1); }
});
child.on('error', (e) => {
  write(JSON.stringify({ ok: false, code: 'E_HELPER_CRASHED', message: `Could not start ${exe}: ${e.message}`, fix: 'Run "screenrec doctor", then retry with SCREENREC_DEBUG=1.' }));
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
process.on('SIGHUP', () => { /* outlive the terminal that started us */ });
// 'close' waits for the recorder's stdout to drain, so its last lines are logged before the exit line
child.on('close', (code, signal) => {
  if (pending) write(stamp(pending));
  write(JSON.stringify({ event: 'exit', code, signal }));
  process.exit(0);
});
