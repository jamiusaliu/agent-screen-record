import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOL_NAMES } from '../../src/mcp/server.ts';
import { COMMANDS } from '../../src/cli/args.ts';

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const EM_DASH = /\u2014/;

test('plugin manifest and MCP config are valid and point at screenrec mcp', () => {
  const manifest = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'screenrec'); assert.ok(manifest.description);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version, 'plugin and package versions agree');
  assert.equal(manifest.homepage, undefined, 'no placeholder homepage'); assert.equal(manifest.repository, undefined, 'no placeholder repository');
  const mcp = JSON.parse(read('plugin/.mcp.json'));
  // Not PATH-dependent: npx fetches the real package (the npm name screenrec belongs to someone else).
  // Pinned to this release: an unpinned name runs whatever npm serves as latest on every agent start.
  const version = JSON.parse(read('package.json')).version;
  assert.deepEqual(mcp.mcpServers.screenrec, { command: 'npx', args: ['-y', `agent-screen-record@${version}`, 'mcp'] });
  assert.equal(JSON.parse(read('package.json')).name, 'agent-screen-record');
});

test('repo-root marketplace lists the plugin from ./plugin', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.ok(m.name && m.owner?.name);
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, JSON.parse(read('plugin/.claude-plugin/plugin.json')).name);
  assert.equal(m.plugins[0].source, './plugin');
});

test('no install instruction points at the npm name screenrec', () => {
  for (const f of ['plugin/skills/screen-record/SKILL.md', 'agents/AGENTS.snippet.md']) {
    assert.doesNotMatch(read(f), /npx (-y )?screenrec|npm (i|install) (-g )?screenrec/, f);
  }
});

test('skill has frontmatter and only mentions tools that exist', () => {
  const skill = read('plugin/skills/screen-record/SKILL.md');
  assert.match(skill, /^---\nname: screen-record\ndescription: .{40,}\n---\n/);
  for (const m of skill.matchAll(/`((?:record|video|list|screenshot|doctor)[a-z_]*)`/g)) assert.ok((TOOL_NAMES as readonly string[]).includes(m[1]), `unknown tool ${m[1]}`);
  assert.doesNotMatch(skill, EM_DASH, 'no em dashes');
});

test('AGENTS snippet only uses real CLI commands', () => {
  const s = read('agents/AGENTS.snippet.md');
  for (const m of s.matchAll(/screenrec ([a-z]+)/g)) assert.ok(m[1] in COMMANDS, `unknown command ${m[1]}`);
  assert.doesNotMatch(s, EM_DASH);
});

// Spec 6.6 and 8: both Chrome routes, the success examples of spec 1, the workflow.
for (const file of ['plugin/skills/screen-record/SKILL.md', 'agents/AGENTS.snippet.md']) {
  test(`${file} covers the workflow, the recipes and both Chrome routes`, () => {
    const s = read(file);
    for (const re of [
      /screencast_start/, /chrome-devtools-mcp/, /--no-usage-statistics --no-performance-crux/,
      /every tab/i, /follow mode/i, /step notes/i, /auto-stop/i, /Allow/, /once per Chrome session/i,
      /tab follow|tab: "follow"/, /tab newest|tab: "newest"/, /url:/, /follow.app/, /Finder/, /Preview/, /QuickTime/, /Downloads/,
      /squeeze/, /gif/i, /trim.edges/, /glow/i, /mark/, /tell the user/i,
      // fix round 1: privacy, install, order, minors
      /macOS only/i, /npm i -g agent-screen-record/, /Focus/, /notifications/, /all other windows/i, /blur.*before.*gif|gif.*after.*blur/i,
      /sidecar/i, /sensitive/i, /meta/, /recording indicator/i, /gitignore/i, /emails?, tokens?, names/i,
      /squeeze, crop, trim/i, /hold(: | )0/, /do not mix routes/i, /needs (a )?window or app|with window or app|--window or --app/i, /mark -- "-/,
    ]) assert.match(s, re, `${file} lacks ${re}`);
  });
}

test('skill description has the extra triggers and is scoped to screen capture', () => {
  const d = /^description: (.*)$/m.exec(read('plugin/skills/screen-record/SKILL.md'))![1];
  for (const t of ['make a gif of what you did', 'show me the bug', 'record yourself reproducing this bug']) assert.ok(d.includes(t), t);
  assert.match(d, /not (for )?audio/i); assert.match(d, /meetings/i);
});

test('snippet header says macOS only, Node 22+, ffmpeg and the install command', () => {
  const head = read('agents/AGENTS.snippet.md').split('\n').slice(0, 6).join('\n');
  for (const re of [/macOS only/i, /Node 22/, /ffmpeg/, /npm i -g agent-screen-record/, /npx -y agent-screen-record/]) assert.match(head, re);
});

test('every shipped version string follows package.json: MCP server, plugin.json, .mcp.json, marketplace.json, AGENTS snippet', async () => {
  const version = JSON.parse(read('package.json')).version;
  assert.equal(JSON.parse(read('plugin/.claude-plugin/plugin.json')).version, version, 'plugin.json');
  assert.ok(JSON.parse(read('plugin/.mcp.json')).mcpServers.screenrec.args.includes(`agent-screen-record@${version}`), '.mcp.json');
  assert.equal(JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].version, version, 'marketplace.json');
  const snippet = read('agents/AGENTS.snippet.md');
  for (const m of snippet.matchAll(/npx -y agent-screen-record(\S*)/g)) assert.equal(m[1], `@${version}`, `snippet npx pinned: ${m[0]}`);
  // the server reads package.json; a literal would drift on the next bump
  assert.doesNotMatch(read('src/mcp/server.ts'), /version: '\d+\.\d+\.\d+'/);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { buildServer } = await import('../../src/mcp/server.ts');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(); await server.connect(a);
  const client = new Client({ name: 'version-test', version: '0.0.0' }); await client.connect(b);
  try { assert.equal(client.getServerVersion()?.version, version, 'MCP server'); }
  finally { await client.close(); await server.close(); }
});
