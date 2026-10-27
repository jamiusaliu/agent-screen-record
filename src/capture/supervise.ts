import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ScreenrecError } from '../core/errors.ts';

const isTs = import.meta.url.endsWith('.ts');

/** Node arguments that run one of our own scripts, from source (through tsx) or from the build. */
export function nodeScriptArgs(script: URL): string[] {
  const file = fileURLToPath(script);
  return isTs ? ['--import', import.meta.resolve('tsx'), file] : [file];
}

/**
 * Starts `exe args` under the supervisor, detached in its own process group, with the recorder's
 * stdout and stderr appended to `logFile`. Returns the supervisor's pid: signal it with SIGINT to
 * stop, or SIGKILL its process group (-pid) to kill everything.
 */
export function superviseSpawn(exe: string, args: string[], logFile: string, o: { stdin?: string } = {}): number {
  const sup = new URL(`./supervisor${isTs ? '.ts' : '.js'}`, import.meta.url);
  const log = fs.openSync(logFile, 'a');
  let p;
  // the supervisor's own stderr goes to the log too, so its failures show in the startup error
  // o.stdin is for secrets (the broker token): argv is visible to every local user through ps
  const forward = o.stdin !== undefined;
  try { p = spawn(process.execPath, [...nodeScriptArgs(sup), ...(forward ? ['--stdin'] : []), logFile, exe, ...args], { detached: true, stdio: [forward ? 'pipe' : 'ignore', 'ignore', log] }); }
  finally { fs.closeSync(log); }
  p.once('error', () => {});
  if (forward) { p.stdin!.on('error', () => {}); p.stdin!.end(o.stdin); }
  p.unref();
  if (!p.pid) throw new ScreenrecError('E_HELPER_CRASHED', 'Could not start the recorder', 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  return p.pid;
}
