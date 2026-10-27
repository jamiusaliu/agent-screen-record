// The clean-room runner's README extractor and tarball allowlist (test/cleanroom/lib.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain .mjs module without type declarations
import { extractBlocks, documentedTools, tarballProblems, resultFor } from '../cleanroom/lib.mjs';

const good = '# T\n\n```bash cleanroom\necho one\n```\n\ntext\n\n```bash cleanroom-mac\necho two\n```\n';

test('strict blocks are extracted in order with their tags and bodies', () => {
  const r = extractBlocks(good);
  assert.deepEqual(r.blocks.map((b: { tag: string; body: string }) => [b.tag, b.body]), [['cleanroom', 'echo one\n'], ['cleanroom-mac', 'echo two\n']]);
  assert.equal(r.candidates, 2);
  assert.deepEqual(r.malformed, []);
});

test('plain sh and bash blocks are not candidates', () => {
  const r = extractBlocks('```sh\nnpm ci\n```\n```bash\nls\n```\nThe ```bash cleanroom``` tag in prose.\n');
  assert.equal(r.blocks.length, 0);
  assert.equal(r.candidates, 0);
});

const variants: Record<string, string> = {
  'trailing space after the tag': '```bash cleanroom \necho x\n```\n',
  'CRLF line endings': '```bash cleanroom\r\necho x\r\n```\r\n',
  'indented fence in a list item': '- step\n\n  ```bash cleanroom\n  echo x\n  ```\n',
  'sh instead of bash': '```sh cleanroom\necho x\n```\n',
  'typo in the tag': '```bash cleanroom-macos\necho x\n```\n',
  'upper case tag': '```bash Cleanroom\necho x\n```\n',
  'tilde fence': '~~~bash cleanroom\necho x\n~~~\n',
  'four backticks': '````bash cleanroom\necho x\n````\n',
  'two spaces before the tag': '```bash  cleanroom\necho x\n```\n',
  'never closed': '```bash cleanroom\necho x\n',
};
for (const [name, text] of Object.entries(variants)) {
  test(`a malformed cleanroom fence is reported, not skipped: ${name}`, () => {
    const r = extractBlocks(good + '\n' + text);
    assert.equal(r.blocks.length, 2, 'the good blocks still parse');
    assert.equal(r.candidates, 3);
    assert.equal(r.malformed.length, 1);
    assert.match(r.malformed[0].text, /cleanroom/i);
    assert.ok(r.malformed[0].line > 10, 'the report names the line');
  });
}

test('documentedTools reads only the tool-list sentence', () => {
  const readme = 'The MCP tools map one to one onto the CLI: `doctor`, `record_start`. `record_start` also returns an image.\n';
  assert.deepEqual(documentedTools(readme), ['doctor', 'record_start']);
  assert.deepEqual(documentedTools('no list here'), []);
});

test('the tarball allowlist accepts the package layout', () => {
  assert.deepEqual(tarballProblems(['package.json', 'README.md', 'LICENSE', 'bin/screenrec', 'bin/screenrec-mac', 'dist/cli/main.js', 'dist/cli/main.js.map', 'plugin/.mcp.json', 'plugin/.claude-plugin/plugin.json', 'agents/AGENTS.snippet.md']), []);
});

test('the tarball allowlist rejects everything else', () => {
  const bad = ['test/unit/x.test.ts', 'src/cli/main.ts', '.superpowers/sdd/x.md', 'docs/demo.gif', 'recordings/a.mp4', 'CLAUDE.md', '.env', '.github/workflows/ci.yml', 'coverage/index.html',
    'dist/.DS_Store', 'plugin/.env.local', 'bin/.npmrc', 'dist/tsconfig.tsbuildinfo', 'bin/screenrec-mac.dSYM/Contents/Info.plist', 'dist/demo.mp4',
    'dist/test/x.js', 'dist/edit/squeeze.test.js', 'dist/fixtures/a.json'];
  const problems = tarballProblems(bad);
  assert.equal(problems.length, bad.length, problems.join('\n'));
});

test('resultFor picks the JSON line of the named output', () => {
  const out = 'screenrec 0.1.0\n{"ok":true,"out":"/w/demo.squeeze.mp4","beforeSec":6}\n{"ok":true,"out":"/w/demo.squeeze.crop.mp4"}\n';
  assert.equal(resultFor(out, 'demo.squeeze.mp4').beforeSec, 6);
  assert.equal(resultFor(out, 'nope.mp4'), undefined);
});
