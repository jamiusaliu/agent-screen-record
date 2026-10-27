import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

/** Where default-named outputs go; `cwd` and `home` are injectable for tests. */
export interface OutputEnv { cwd?: string; home?: string }

/** A folder this process can create files in. */
export function isWritableDir(d: string): boolean {
  try { fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK); return fs.statSync(d).isDirectory(); } catch { return false; }
}

function currentDir(): string | undefined {
  try { return process.cwd(); } catch { return undefined; }  // the cwd was deleted
}

/**
 * The default output folder: <cwd>/recordings, created with a catch-all .gitignore. When the cwd is
 * "/" or not writable (an MCP server launched by a desktop app often runs in "/"), it is
 * ~/Movies/screenrec instead, created without a .gitignore (it is not a working tree).
 */
export function recordingsDir(cwd: string | undefined = currentDir(), home: string = os.homedir()): string {
  if (cwd !== undefined && path.resolve(cwd) !== path.parse(path.resolve(cwd)).root && isWritableDir(cwd)) {
    const d = path.join(cwd, 'recordings');
    // 0700 when we create it, as for ~/Movies/screenrec; a folder that already exists is left alone
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const gi = path.join(d, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    return d;
  }
  const d = path.join(home, 'Movies', 'screenrec');
  // 0700: recordings and their sidecars hold window titles, URLs and step notes
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function defaultRecordingBase(now: Date = new Date()): string {
  return `rec-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function stripExt(p: string): string {
  const ext = path.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

/**
 * <input-without-ext>.<command>.<ext> next to the input, or -2, -3 ... when taken. When the input's
 * folder exists but is not writable, the same name goes in the default output folder instead.
 */
export function derivedOut(input: string, command: string, ext: string, env: OutputEnv = {}): string {
  const dir = path.dirname(input);
  const folder = fs.existsSync(dir) && !isWritableDir(dir) ? recordingsDir(env.cwd ?? currentDir(), env.home ?? os.homedir()) : dir;
  const base = path.join(folder, `${path.basename(stripExt(input))}.${command}`);
  let candidate = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${base}-${i}.${ext}`;
  return candidate;
}
