// Global constraint: subprocesses run from argument arrays, never through a shell, so a window title,
// path, tab pattern or step note can never become a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : /\.(ts|mts|cts|js|mjs)$/.test(d.name) ? [path.join(dir, d.name)] : []);
const rel = (f: string) => path.relative(root, f);

// Several files alias `const exec = promisify(execFile)`, so a bare `exec(` is not a shell by itself:
// what matters is which child_process functions are imported, and that no call passes shell: true.
const SAFE_IMPORTS = new Set(['execFile', 'execFileSync', 'spawn', 'type ChildProcess', 'type ChildProcessWithoutNullStreams']);

test('no shell execution anywhere in src', () => {
  const bad: string[] = [];
  for (const f of files(root)) {
    const s = fs.readFileSync(f, 'utf8');
    const r = rel(f);
    if (/\bshell\s*:/.test(s)) bad.push(`${r}: shell option`);
    if (/\bexecSync\s*\(|\bspawnSync\s*\(|\bfork\s*\(/.test(s)) bad.push(`${r}: execSync, spawnSync or fork`);
    if (/require\s*\(\s*['"](node:)?child_process['"]|import\s*\(\s*['"](node:)?child_process['"]/.test(s)) bad.push(`${r}: dynamic child_process`);
    if (/from\s+['"]child_process['"]/.test(s)) bad.push(`${r}: child_process without the node: prefix`);
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)) {
      for (const name of m[1].split(',').map((x) => x.trim().replace(/\s+as\s+\w+$/, '')).filter(Boolean)) {
        if (!SAFE_IMPORTS.has(name)) bad.push(`${r}: imports ${name} from node:child_process`);
      }
    }
    if (/import\s+\*\s+as\s+\w+\s+from\s+['"]node:child_process['"]|import\s+\w+\s+from\s+['"]node:child_process['"]/.test(s)) bad.push(`${r}: namespace import of node:child_process`);
    if (/['"`](\/bin\/(ba|z)?sh|sh|bash|zsh|cmd(\.exe)?|powershell)['"`]\s*,\s*\[\s*['"`](-c|\/c|-Command)['"`]/.test(s)) bad.push(`${r}: runs a shell with -c`);
  }
  assert.deepEqual(bad, []);
});

test('the AppleScript is a constant: no user text is ever spliced into it', () => {
  const s = fs.readFileSync(path.join(root, 'capture/chrome-applescript.ts'), 'utf8');
  const script = /const SCRIPT = `([\s\S]*?)`;/.exec(s);
  assert.ok(script, 'SCRIPT constant found');
  assert.doesNotMatch(script[1], /\$\{/, 'no interpolation in the AppleScript');
  assert.match(s, /exec\('osascript', \['-e', SCRIPT\]\)/);
  // osascript is the only AppleScript entry point in src
  for (const f of files(root)) if (rel(f) !== 'capture/chrome-applescript.ts') assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /osascript/, rel(f));
});
