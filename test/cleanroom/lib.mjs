// Pure helpers for the clean-room runner (test/cleanroom/run.mjs). No I/O, so npm test covers them
// (test/unit/cleanroom-lib.test.ts).

export const TAGS = ['cleanroom', 'cleanroom-mac'];

// Strict form: a column-0 fence ```bash <tag> with LF endings, closed by a column-0 ```.
const STRICT = /^```bash (cleanroom|cleanroom-mac)\n([\s\S]*?)^```$/gm;
// Loose form: any line that opens a fence (backticks or tildes, any indent) and whose info string
// mentions cleanroom in any spelling, language or line ending.
const LOOSE = /^[ \t]*(?:`{3,}|~{3,})[^\n`]*cleanroom/i;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Returns the runnable blocks in document order plus every fence line that looks like a cleanroom
// block but is not in the strict form. A non-empty `malformed` must fail the run: those blocks
// would otherwise be skipped without a word.
export function extractBlocks(readme) {
  const blocks = [...readme.matchAll(STRICT)].map((m) => ({ tag: m[1], body: m[2], line: lineOf(readme, m.index) }));
  const strictLines = new Set(blocks.map((b) => b.line));
  const candidates = [];
  readme.split('\n').forEach((text, i) => { if (LOOSE.test(text)) candidates.push({ line: i + 1, text: text.replace(/\r$/, '') }); });
  const malformed = candidates.filter((c) => !strictLines.has(c.line));
  return { blocks, candidates: candidates.length, malformed };
}

// The tool names from the README sentence "The MCP tools map one to one onto the CLI: `a`, `b` ... ."
export function documentedTools(readme) {
  const sentence = readme.match(/The MCP tools map one to one onto the CLI: ([^\n]*?)\.(?: |$)/m)?.[1] || '';
  return [...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

// Allowlist for the packed tarball (names without the leading "package/"): the package.json `files`
// dirs plus the three files npm always adds. Returns one message per offending entry.
export const ALLOWED_DIRS = ['bin/', 'dist/', 'plugin/', 'agents/'];
export const ALLOWED_FILES = ['package.json', 'README.md', 'LICENSE'];
export function tarballProblems(names) {
  const problems = [];
  for (const n of names) {
    if (n.endsWith('/')) continue; // directory entries
    if (!ALLOWED_FILES.includes(n) && !ALLOWED_DIRS.some((d) => n.startsWith(d))) problems.push(`${n}: outside the allowlist`);
    else if (/(^|\/)(\.DS_Store|\.env[^/]*|\.npmrc)$|\.(tsbuildinfo|log|mp4|mov|webm|gif|png|tgz)$|\.dSYM(\/|$)/.test(n)) problems.push(`${n}: unwanted file type`);
    else if (n.startsWith('dist/') && /(^|\/)(test|tests|__tests__|fixtures)\/|\.(test|spec)\.[cm]?js(\.map)?$/.test(n)) problems.push(`${n}: test file under dist`);
  }
  return problems;
}

// The JSON result line a clean-up command printed for `out` (matched by basename), so a later
// `--json` command in the same block cannot be mistaken for it.
export function resultFor(stdout, outBasename) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.out === 'string' && j.out.split(/[\\/]/).at(-1) === outBasename) return j;
    } catch { /* not JSON */ }
  }
  return undefined;
}
