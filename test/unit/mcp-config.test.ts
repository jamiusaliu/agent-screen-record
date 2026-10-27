import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { findDevtoolsMcp, devtoolsMcpCheck, parseCodexMcpServers, devtoolsFlags } from '../../src/core/mcp-config.ts';

const fx = (p: string) => new URL(`../fixtures/mcp-config/${p}`, import.meta.url).pathname;
const SECRETS = /FIXTURE_SECRET/;

test('finds the entry in ~/.claude.json mcpServers with autoConnect and the usage flag', () => {
  const r = findDevtoolsMcp({ home: fx('claude-home'), cwd: fx('empty-home'), env: {} });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { file: path.join(fx('claude-home'), '.claude.json'), server: 'chrome-devtools', autoConnect: true, usageStatisticsOff: true });
  const c = devtoolsMcpCheck({ home: fx('claude-home'), cwd: fx('empty-home') });
  assert.equal(c.ok, true);
  assert.match(c.detail, /^available \(autoConnect on\)/);
  assert.doesNotMatch(JSON.stringify(c), SECRETS);
});

test('finds per-project entries in ~/.claude.json for the current project only', () => {
  const r = findDevtoolsMcp({ home: fx('claude-project-home'), cwd: '/work/app' });
  assert.equal(r.length, 1);
  assert.equal(r[0].server, 'browser'); assert.equal(r[0].autoConnect, false);
});

test('finds ./.mcp.json and warns when --no-usage-statistics is missing', () => {
  const c = devtoolsMcpCheck({ home: fx('empty-home'), cwd: fx('project'), env: {} });
  assert.equal(c.ok, false);
  assert.match(c.detail, /^available \(autoConnect off\)/);
  assert.match(c.fix!, /--no-usage-statistics/);
  assert.match(c.fix!, /\.mcp\.json/);
  assert.doesNotMatch(JSON.stringify(c), SECRETS);
});

test('codex config.toml: quoted table names, multi-line args, comments, env subtables ignored', () => {
  const toml = fs.readFileSync(fx('codex-home/.codex/config.toml'), 'utf8');
  const servers = parseCodexMcpServers(toml);
  assert.deepEqual(Object.keys(servers).sort(), ['chrome devtools', 'docs', 'inline-env']);
  assert.deepEqual(servers['chrome devtools'], { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--auto-connect'], envOptOut: false });
  assert.equal(servers['inline-env'].envOptOut, true, 'CI in an inline env table opts out');
  assert.doesNotMatch(JSON.stringify(servers), SECRETS);
  const r = findDevtoolsMcp({ home: fx('codex-home'), cwd: fx('empty-home'), env: {} });
  const file = path.join(fx('codex-home'), '.codex', 'config.toml');
  assert.deepEqual(r, [{ file, server: 'chrome devtools', autoConnect: true, usageStatisticsOff: false }, { file, server: 'inline-env', autoConnect: false, usageStatisticsOff: true }]);
});

test('not configured, and unreadable or broken files are skipped', () => {
  assert.deepEqual(findDevtoolsMcp({ home: fx('empty-home'), cwd: fx('empty-home') }), []);
  assert.deepEqual(findDevtoolsMcp({ home: fx('broken-home'), cwd: fx('empty-home') }), []);
  const c = devtoolsMcpCheck({ home: fx('empty-home'), cwd: fx('empty-home') });
  assert.equal(c.ok, true); assert.match(c.detail, /^not configured/);
});

test('flag forms: =true/=false, a following true/false, --no- and camelCase; last one wins', () => {
  const f = (args: string[]) => { const r = devtoolsFlags(args); return [r.autoConnect, r.usageStatisticsOff]; };
  assert.deepEqual(f([]), [false, false], 'usage statistics are on by default');
  assert.deepEqual(f(['--autoConnect=false', '--usageStatistics=false']), [false, true]);
  assert.deepEqual(f(['--auto-connect=true', '--usage-statistics', 'false']), [true, true]);
  assert.deepEqual(f(['--autoconnect', '--no-usageStatistics']), [true, true]);
  assert.deepEqual(f(['--no-usage-statistics', '--usage-statistics']), [false, false]);
  assert.deepEqual(f(['--autoConnect', '--no-auto-connect']), [false, false]);
});

test('the CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS or CI env key opts out (names only, values never read out)', () => {
  const r = findDevtoolsMcp({ home: fx('envoff-home'), cwd: fx('empty-home'), env: {} });
  assert.equal(r[0].usageStatisticsOff, true);
  assert.doesNotMatch(JSON.stringify(devtoolsMcpCheck({ home: fx('envoff-home'), cwd: fx('empty-home'), env: {} })), SECRETS);
  const leaky = findDevtoolsMcp({ home: fx('empty-home'), cwd: fx('project'), env: {} });
  assert.equal(leaky[0].usageStatisticsOff, false);
  const viaEnv = findDevtoolsMcp({ home: fx('empty-home'), cwd: fx('project'), env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' } });
  assert.equal(viaEnv[0].usageStatisticsOff, true, 'set in the environment the agent passes on');
});

function pluginHome(t: { after: (fn: () => void) => void }, enabled: boolean, settingsEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  const key = 'chrome-devtools-mcp@claude-plugins-official';
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    [key]: [{ scope: 'user', installPath: fx('plugin-cache/chrome-devtools-mcp'), version: '1.11.0' }] } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [key]: enabled }, env: settingsEnv }));
  return home;
}

test('an enabled Claude Code plugin that ships chrome-devtools-mcp is found; a disabled one is not', (t) => {
  const home = pluginHome(t, true);
  const r = findDevtoolsMcp({ home, cwd: fx('empty-home'), env: {} });
  assert.deepEqual(r, [{ file: 'plugin chrome-devtools-mcp@claude-plugins-official', server: 'chrome-devtools', autoConnect: false, usageStatisticsOff: false }]);
  const c = devtoolsMcpCheck({ home, cwd: fx('empty-home'), env: {} });
  assert.equal(c.ok, false); assert.match(c.detail, /^available \(autoConnect off\): "chrome-devtools" in plugin chrome-devtools-mcp@claude-plugins-official/);
  assert.match(c.fix!, /CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS/, 'plugin args cannot be edited, so the fix is the env key');
  assert.deepEqual(findDevtoolsMcp({ home: pluginHome(t, false), cwd: fx('empty-home'), env: {} }), []);
});

test('the env key in ~/.claude/settings.json env opts the plugin out', (t) => {
  const home = pluginHome(t, true, { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'FIXTURE_SECRET_ENV' });
  const c = devtoolsMcpCheck({ home, cwd: fx('empty-home'), env: {} });
  assert.equal(c.ok, true);
  assert.doesNotMatch(JSON.stringify(c), SECRETS);
});
