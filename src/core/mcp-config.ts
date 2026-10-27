// Read-only detection of a chrome-devtools-mcp server in the agent MCP configuration files (spec 6.6).
// Only each server's name, `command` and `args` are read, plus whether its env has one of the two
// opt-out key NAMES. Env values, headers and every other field may hold secrets: they are never
// copied out of the parsed file, so nothing here can print them.
import fs from 'node:fs'; import path from 'node:path';

interface ServerSpec { command?: string; args?: string[]; envOptOut?: boolean }

/** chrome-devtools-mcp 1.11.0 turns usage statistics off when either is set (src/config/ConfigParser.ts). */
const OPT_OUT_ENV = ['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', 'CI'];
const hasOptOut = (env: unknown) => !!env && typeof env === 'object' && OPT_OUT_ENV.some((k) => k in (env as object));
export interface DevtoolsMcpEntry { file: string; server: string; autoConnect: boolean; usageStatisticsOff: boolean }
export interface McpCheck { name: string; ok: boolean; detail: string; fix?: string }

const NAME = 'Chrome DevTools MCP route';
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only command and args of each server. */
function pickServers(v: unknown): Record<string, ServerSpec> {
  const out: Record<string, ServerSpec> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [name, s] of Object.entries(v as Record<string, unknown>)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { command?: unknown; args?: unknown; env?: unknown };
    out[name] = { command: typeof o.command === 'string' ? o.command : undefined, args: strings(o.args), envOptOut: hasOptOut(o.env) };
  }
  return out;
}

function readJson(file: string): Record<string, unknown> | null {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

// ---- minimal TOML: [mcp_servers.<name>] tables, `command` string and `args` string array only ----

/** Splits a TOML line at the first # outside a string. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Every string literal in `s`, in order ("basic" with escapes, 'literal' without). */
function stringLiterals(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const q = s[i];
    if (q !== '"' && q !== "'") continue;
    let v = '';
    for (i++; i < s.length && s[i] !== q; i++) {
      if (q === '"' && s[i] === '\\' && i + 1 < s.length) {
        const e = s[++i];
        if (e === 'u' || e === 'U') { const n = e === 'u' ? 4 : 8; v += String.fromCodePoint(parseInt(s.slice(i + 1, i + 1 + n), 16) || 0xfffd); i += n; }
        else v += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
      } else v += s[i];
    }
    out.push(v);
  }
  return out;
}

/** Dotted TOML key ("mcp_servers.\"chrome devtools\".env") as its parts. */
function keyParts(k: string): string[] {
  const parts: string[] = [];
  for (const m of k.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/g)) {
    const p = m[1];
    parts.push(p.startsWith('"') || p.startsWith("'") ? stringLiterals(p)[0] ?? '' : p);
  }
  return parts;
}

const bracketDepth = (s: string): number => {
  let d = 0, q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '[') d++;
    else if (c === ']') d--;
  }
  return d;
};

/** `[mcp_servers.<name>]` tables of a Codex config.toml, with their command and args. Subtables (env) are skipped. */
export function parseCodexMcpServers(toml: string): Record<string, ServerSpec> {
  const out: Record<string, ServerSpec> = {};
  let current: string | null = null;
  let envOf: string | null = null;  // inside [mcp_servers.<name>.env]: only key names are looked at
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const header = /^\[([^[\]]+)\]$/.exec(line);
    if (header) {
      const parts = keyParts(header[1]);
      const isServer = parts[0] === 'mcp_servers' && parts.length >= 2;
      current = isServer && parts.length === 2 ? parts[1] : null;
      envOf = isServer && parts.length === 3 && parts[2] === 'env' ? parts[1] : null;
      for (const n of [current, envOf]) if (n !== null) out[n] ??= { envOptOut: false };
      continue;
    }
    if (line.startsWith('[')) { current = envOf = null; continue; }  // [[array of tables]]
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(line);
    if (kv && envOf !== null) { if (OPT_OUT_ENV.includes(kv[1].replace(/"/g, ''))) out[envOf].envOptOut = true; continue; }
    if (!kv || current === null) continue;
    if (kv[1] === 'env' && kv[2].startsWith('{')) {
      // inline table: key names only
      if ([...kv[2].matchAll(/[{,]\s*"?([A-Za-z0-9_]+)"?\s*=/g)].some((m) => OPT_OUT_ENV.includes(m[1]))) out[current].envOptOut = true;
      continue;
    }
    let value = kv[2];
    while (value.startsWith('[') && bracketDepth(value) > 0 && i + 1 < lines.length) value += ' ' + stripComment(lines[++i]);
    if (kv[1] === 'command') out[current].command = stringLiterals(value)[0];
    if (kv[1] === 'args' && value.startsWith('[')) out[current].args = stringLiterals(value);
  }
  return out;
}

// ---- detection ----

const isDevtools = (s: ServerSpec) => [s.command ?? '', ...(s.args ?? [])].some((a) => /chrome-devtools-mcp/i.test(a));

/** Reads a boolean flag the way yargs does: --x, --x=v, --x v, --no-x; the last one wins. `names` are lower-case, dashes removed. */
function boolFlag(args: string[], names: string[], fallback: boolean): boolean {
  let v = fallback;
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '');
  for (let i = 0; i < args.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) continue;
    const key = norm(m[1]);
    if (names.includes(key)) {
      const next = args[i + 1];
      if (m[2] !== undefined) v = m[2].toLowerCase() !== 'false';
      else if (next === 'true' || next === 'false') { v = next === 'true'; i++; }
      else v = true;
    } else if (key.startsWith('no') && names.includes(key.slice(2))) v = false;
  }
  return v;
}

export function devtoolsFlags(args: string[]): { autoConnect: boolean; usageStatisticsOff: boolean } {
  return {
    autoConnect: boolFlag(args, ['autoconnect'], false),
    usageStatisticsOff: !boolFlag(args, ['usagestatistics'], true),  // on by default in chrome-devtools-mcp
  };
}

/** Enabled Claude Code plugins (user, project, local settings; later wins) that declare MCP servers. */
function pluginSources(home: string, cwd: string): { file: string; servers: Record<string, ServerSpec> }[] {
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins;
  if (!installed || typeof installed !== 'object') return [];
  const enabled: Record<string, unknown> = {};
  for (const f of [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    const e = readJson(f)?.enabledPlugins;
    if (e && typeof e === 'object') Object.assign(enabled, e);
  }
  const out: { file: string; servers: Record<string, ServerSpec> }[] = [];
  for (const [key, installs] of Object.entries(installed as Record<string, unknown>)) {
    if (enabled[key] !== true) continue;
    for (const inst of Array.isArray(installs) ? installs : [installs]) {
      const dir = (inst as { installPath?: unknown })?.installPath;
      if (typeof dir !== 'string') continue;
      let decl: unknown = readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.mcpServers;
      if (typeof decl === 'string') decl = readJson(path.resolve(dir, decl))?.mcpServers;  // a path to an .mcp.json
      decl ??= readJson(path.join(dir, '.mcp.json'))?.mcpServers;
      out.push({ file: `plugin ${key}`, servers: pickServers(decl) });
    }
  }
  return out;
}

/**
 * chrome-devtools-mcp entries in ~/.claude.json (global and this project), ./.mcp.json, enabled Claude Code
 * plugins and ~/.codex/config.toml. `env` is the environment the agent passes on (default process.env):
 * an opt-out key there, or in ~/.claude/settings.json `env`, turns usage statistics off for every entry.
 */
export function findDevtoolsMcp(o: { home: string; cwd: string; env?: NodeJS.ProcessEnv }): DevtoolsMcpEntry[] {
  const globalOptOut = hasOptOut(o.env ?? process.env) || hasOptOut(readJson(path.join(o.home, '.claude', 'settings.json'))?.env);
  const sources: { file: string; servers: Record<string, ServerSpec> }[] = [];
  const claudeFile = path.join(o.home, '.claude.json');
  const claude = readJson(claudeFile);
  if (claude) {
    sources.push({ file: claudeFile, servers: pickServers(claude.mcpServers) });
    const projects = claude.projects as Record<string, { mcpServers?: unknown }> | undefined;
    const mine = projects && typeof projects === 'object' ? projects[path.resolve(o.cwd)] : undefined;
    if (mine) sources.push({ file: claudeFile, servers: pickServers(mine.mcpServers) });
  }
  const projectFile = path.join(o.cwd, '.mcp.json');
  const project = readJson(projectFile);
  if (project) sources.push({ file: projectFile, servers: pickServers(project.mcpServers) });
  sources.push(...pluginSources(o.home, o.cwd));
  const codexFile = path.join(o.home, '.codex', 'config.toml');
  try { sources.push({ file: codexFile, servers: parseCodexMcpServers(fs.readFileSync(codexFile, 'utf8')) }); } catch { /* none */ }

  const hits: DevtoolsMcpEntry[] = [];
  for (const { file, servers } of sources) {
    for (const [server, spec] of Object.entries(servers)) {
      if (!isDevtools(spec)) continue;
      const f = devtoolsFlags(spec.args ?? []);
      hits.push({ file, server, autoConnect: f.autoConnect, usageStatisticsOff: f.usageStatisticsOff || !!spec.envOptOut || globalOptOut });
    }
  }
  return hits;
}

const tilde = (file: string, home: string) => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);

/** The doctor line for the Chrome DevTools MCP route. Names files and servers only. */
export function devtoolsMcpCheck(o: { home: string; cwd: string; env?: NodeJS.ProcessEnv }): McpCheck {
  const hits = findDevtoolsMcp(o);
  if (hits.length === 0) return { name: NAME, ok: true, detail: 'not configured (optional; screenrec records tabs itself with --tab)' };
  const first = hits[0];
  const more = hits.length > 1 ? ` (and ${hits.length - 1} more)` : '';
  const detail = `available (autoConnect ${first.autoConnect ? 'on' : 'off'}): "${first.server}" in ${tilde(first.file, o.home)}${more}`;
  const leaky = hits.filter((h) => !h.usageStatisticsOff);
  if (leaky.length === 0) return { name: NAME, ok: true, detail };
  const files = leaky.filter((h) => !h.file.startsWith('plugin '));
  const plugins = leaky.filter((h) => h.file.startsWith('plugin '));
  const where = (hs: DevtoolsMcpEntry[]) => hs.map((h) => `"${h.server}" in ${tilde(h.file, o.home)}`).join(', ');
  const fixes = ['chrome-devtools-mcp sends usage statistics to Google by default.'];
  if (files.length) fixes.push(`Add --no-usage-statistics --no-performance-crux to the args of ${where(files)}.`);
  if (plugins.length) fixes.push(`For ${where(plugins)} (plugin args cannot be edited), export CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 in the shell that starts the agent, or set it in the "env" of ~/.claude/settings.json.`);
  return { name: NAME, ok: false, detail, fix: fixes.join(' ') };
}
