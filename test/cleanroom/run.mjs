#!/usr/bin/env node
// Clean-room install test: npm run test:cleanroom (macOS only: packing builds the universal helper).
//
// 1. Clones the commit under test (CLEANROOM_REF, default HEAD) from this checkout into an empty temp dir.
// 2. Runs `npm ci` and `npm pack` there (pack runs prepack: dist/ and the universal helper), then checks the
//    tarball against an allowlist.
// 3. Installs the tarball into another empty temp prefix with a fresh npm cache, a temp HOME and a PATH that
//    holds only the install, node, npm, ffmpeg, git and the system dirs, then runs every ```bash cleanroom
//    block of the README exactly as written. ```bash cleanroom-mac blocks record the main display, so they
//    run only with CLEANROOM_MAC=1. A fence that looks like a cleanroom block but is not in the strict form
//    fails the run.
// 4. Starts `screenrec mcp` from the install and checks the MCP initialize + tools/list handshake.
// 5. Follows the README's build-from-source route as written, with `npm install -g .` going to a temp npm
//    prefix (CLEANROOM_SKIP_SOURCE=1 skips it).
// Assertions use bounds, not exact values. Temp dirs are removed at the end, on failure and on Ctrl-C too,
// unless CLEANROOM_KEEP=1. The only network use is npm fetching dependencies from the registry.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlocks, documentedTools, tarballProblems, resultFor } from './lib.mjs';
const REPO_URL = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

if (process.platform !== 'darwin') {
  console.error('test:cleanroom needs macOS: it packs a release, and prepack builds the universal macOS capture helper.');
  process.exit(1);
}

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runMac = process.env.CLEANROOM_MAC === '1';
const keep = process.env.CLEANROOM_KEEP === '1';
const tmpRoot = fs.realpathSync(os.tmpdir());
const base = fs.mkdtempSync(path.join(tmpRoot, 'screenrec-cleanroom-'));
const dir = (name) => { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); return d; };
const failures = [];
const notes = [];
const children = new Set(); // process-group leaders still running

function log(msg) { console.log(`\n[cleanroom] ${msg}`); }
function check(ok, what) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
function between(x, lo, hi) { return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi; }
const which = (cmd) => { const r = spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };

// Removes the temp dir and the SwiftPM lock files named after it, unless CLEANROOM_KEEP=1.
function cleanup() {
  if (keep) { console.log(`\nkept ${base} (CLEANROOM_KEEP=1)`); return; }
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  const tag = base.replace(/[/.]/g, '_');
  for (const f of fs.readdirSync(tmpRoot)) if (f.startsWith(tag)) fs.rmSync(path.join(tmpRoot, f), { recursive: true, force: true, maxRetries: 5 });
}
const killGroup = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\n[cleanroom] ${sig}: stopping`);
    for (const pid of children) killGroup(pid);
    cleanup();
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]);
  });
}

// The real global prefix must look the same afterwards: nothing here installs into it.
const realPrefix = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', env: { ...process.env, npm_config_prefix: undefined } }).stdout?.trim() || '';
function prefixSnapshot() {
  if (!realPrefix) return '';
  return JSON.stringify(['lib/node_modules/agent-screen-record', 'bin/screenrec'].map((rel) => {
    const p = path.join(realPrefix, rel);
    try {
      const st = fs.lstatSync(p);
      return { rel, ino: st.ino, mtimeMs: st.mtimeMs, link: st.isSymbolicLink() ? fs.readlinkSync(p) : null };
    } catch { return { rel, missing: true }; }
  }));
}
const prefixBefore = prefixSnapshot();

// The child environment. Nothing from npm's own run of this script (npm_* vars, the dev tree's
// node_modules/.bin), no screenrec settings, no BASH_ENV or ENV, a temp HOME, a fresh npm cache, empty npm
// config files and a temp global prefix. PATH is built, not filtered: a shim dir links only node, npm, npx,
// ffmpeg, ffprobe and git, so the real global bin dir (which may hold another screenrec) is not on it.
const npmCache = dir('npm-cache');
const userRc = path.join(base, 'user.npmrc'); fs.writeFileSync(userRc, '');
const globalRc = path.join(base, 'global.npmrc'); fs.writeFileSync(globalRc, '');
const globalPrefix = dir('global');
const screenrecHome = dir('screenrec-home');
const fakeHome = dir('home');
const shims = dir('shims');
for (const tool of ['node', 'npm', 'npx', 'ffmpeg', 'ffprobe', 'git']) {
  const found = tool === 'node' ? process.execPath : which(tool);
  if (found) fs.symlinkSync(fs.realpathSync(found), path.join(shims, tool));
  else notes.push(`${tool} was not found on PATH`);
}
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
function cleanEnv(binFirst) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/i.test(k) || /^SCREENREC_/.test(k) || ['INIT_CWD', 'NODE_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'HOME', 'PATH'].includes(k)) continue;
    env[k] = v;
  }
  env.PATH = [...(binFirst ? [binFirst] : []), shims, ...SYSTEM_PATH].join(path.delimiter);
  Object.assign(env, {
    HOME: fakeHome, npm_config_cache: npmCache, npm_config_userconfig: userRc, npm_config_globalconfig: globalRc,
    npm_config_prefix: globalPrefix, npm_config_update_notifier: 'false', npm_config_fund: 'false',
    npm_config_audit: 'false', SCREENREC_HOME: screenrecHome,
  });
  return env;
}

// Runs a command in its own process group; on time-out the whole group is killed (ffmpeg, swift-build,
// a recorder). Rejects on a non-zero exit. Resolves with stdout (when piped) and the duration in seconds.
function run(cmd, args, { cwd, env = cleanEnv(), pipe = false, timeoutSec = 600 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', pipe ? 'pipe' : 'inherit', 'inherit'] });
    children.add(child.pid);
    let stdout = '';
    let timedOut = false;
    if (pipe) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); }); }
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutSec * 1000);
    const done = (err) => {
      clearTimeout(timer); children.delete(child.pid);
      const sec = (Date.now() - t0) / 1000;
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${err}`));
      else resolve({ stdout, sec });
    };
    child.on('error', (e) => done(e.message));
    child.on('close', (code, sig) => {
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      if (timedOut) done(`timed out after ${timeoutSec} s (process group killed)`);
      else if (code !== 0) done(`exited ${code ?? sig} after ${sec} s`);
      else done();
    });
  });
}

function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : NaN;
}
function lipoArchs(file) {
  const r = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\s+/) : [];
}
function lastJson(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) { try { return JSON.parse(line); } catch { /* not JSON */ } }
  return undefined;
}
function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function main() {
  // 1. Fresh clone of the commit under test.
  const ref = process.env.CLEANROOM_REF || 'HEAD';
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (git(['status', '--porcelain'])) notes.push('the checkout has uncommitted changes; the clean room tests the commit only');
  const src = path.join(base, 'src');
  log(`cloning ${ref} (${sha.slice(0, 7)}) from ${repo} into ${src}`);
  git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', repo, src]);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '-B', 'cleanroom', sha], src);
  check(!fs.existsSync(path.join(src, 'node_modules')) && !fs.existsSync(path.join(src, 'dist')), 'the clone starts without node_modules or dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(src, 'README.md'), 'utf8');

  // The README blocks are checked before the slow pack, so a malformed fence fails in seconds.
  const { blocks, candidates, malformed } = extractBlocks(readme);
  check(malformed.length === 0, `every cleanroom fence in README.md is in the strict form (${blocks.length} strict, ${candidates} candidates)`
    + malformed.map((m) => `\n      line ${m.line}: ${m.text}  (use \`\`\`bash cleanroom or \`\`\`bash cleanroom-mac at column 0, LF endings, closed by \`\`\`)`).join(''));
  if (!check(blocks.some((b) => b.tag === 'cleanroom'), 'README has ```bash cleanroom blocks') || malformed.length) throw new Error('README blocks are not runnable as tagged');

  // 2. npm ci + npm pack (prepack builds dist/ and the universal helper).
  log('npm ci in the clone');
  await run('npm', ['ci'], { cwd: src, timeoutSec: 900 });
  const packDir = dir('pack');
  log('npm pack (runs prepack: TypeScript build and universal native helper; several minutes)');
  const packed = await run('npm', ['pack', '--pack-destination', packDir], { cwd: src, timeoutSec: 1800 });
  const tgzs = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  if (!check(tgzs.length === 1, `npm pack wrote one tarball (${tgzs.join(', ') || 'none'})`)) throw new Error('no tarball');
  const tgz = path.join(packDir, tgzs[0]);
  check(tgzs[0] === `${pkg.name}-${pkg.version}.tgz`, `tarball is named ${pkg.name}-${pkg.version}.tgz`);
  const size = fs.statSync(tgz).size;
  const tar = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  if (!check(tar.status === 0, `tar -tzf lists the tarball${tar.status ? `: ${tar.stderr.trim()}` : ''}`)) throw new Error('unreadable tarball');
  const names = tar.stdout.split('\n').filter(Boolean).map((n) => n.replace(/^package\//, ''));
  log(`tarball ${tgzs[0]}: ${(size / 1024).toFixed(1)} KiB packed, ${names.length} files (pack took ${packed.sec.toFixed(0)} s)`);
  console.log(`CLEANROOM_TARBALL size_bytes=${size} files=${names.length}`);
  for (const f of ['package.json', 'README.md', 'LICENSE', 'bin/screenrec', 'bin/screenrec-mac', 'dist/cli/main.js', 'dist/mcp/server.js']) check(names.includes(f), `tarball holds ${f}`);
  check(names.some((n) => n.startsWith('plugin/')) && names.some((n) => n.startsWith('agents/')), 'tarball holds plugin/ and agents/');
  const problems = tarballProblems(names);
  check(problems.length === 0, `every tarball entry is on the allowlist (bin, dist, plugin, agents, package.json, README.md, LICENSE; no tests under dist)${problems.map((p) => `\n      ${p}`).join('')}`);
  // Modes from the extracted files (with -p, so the developer's umask cannot strip them), not from parsing `tar -tv` columns.
  const unpacked = dir('unpacked');
  const x = spawnSync('tar', ['-xpzf', tgz, '-C', unpacked, 'package/bin/screenrec', 'package/bin/screenrec-mac'], { encoding: 'utf8' });
  check(x.status === 0, `the bin files extract from the tarball${x.status ? `: ${x.stderr.trim()}` : ''}`);
  for (const f of ['bin/screenrec', 'bin/screenrec-mac']) {
    const p = path.join(unpacked, 'package', f);
    const mode = fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : 0;
    check((mode & 0o111) === 0o111, `${f} is executable in the tarball (${mode.toString(8)})`);
  }

  // 3. Install the tarball into an empty prefix.
  const room = dir('room');
  fs.writeFileSync(path.join(room, 'package.json'), JSON.stringify({ name: 'cleanroom', version: '0.0.0', private: true }, null, 2));
  log(`npm install ${tgzs[0]} into ${room} (fresh cache ${npmCache})`);
  await run('npm', ['install', tgz], { cwd: room, timeoutSec: 600 });
  const bin = path.join(room, 'node_modules', '.bin');
  const installed = path.join(room, 'node_modules', pkg.name);
  check(fs.existsSync(path.join(bin, 'screenrec')), 'the install links node_modules/.bin/screenrec');
  for (const dev of Object.keys(pkg.devDependencies || {})) check(!fs.existsSync(path.join(room, 'node_modules', dev)), `devDependency ${dev} is not installed`);
  for (const dep of Object.keys(pkg.dependencies || {})) check(fs.existsSync(path.join(room, 'node_modules', dep)), `dependency ${dep} is installed`);
  const archs = lipoArchs(path.join(installed, 'bin', 'screenrec-mac'));
  check(archs.includes('arm64') && archs.includes('x86_64'), `installed helper is universal (lipo -archs: ${archs.join(' ') || 'none'})`);
  const env = cleanEnv(bin);
  const resolved = spawnSync('bash', ['-c', 'command -v screenrec'], { env, encoding: 'utf8' }).stdout.trim();
  check(resolved === path.join(bin, 'screenrec'), `screenrec on PATH is the clean-room install (${resolved})`);

  // 4. Every tagged README block, exactly as written.
  const work = dir('work');
  for (const [i, b] of blocks.entries()) {
    if (b.tag === 'cleanroom-mac' && !runMac) {
      const why = 'set CLEANROOM_MAC=1 to run it (it records the main display and needs Screen Recording permission)';
      log(`SKIPPED README block ${i + 1} (${b.tag}, line ${b.line}): ${why}`);
      notes.push(`README block ${i + 1} (${b.tag}) was not run: ${why}`);
      continue;
    }
    log(`README block ${i + 1} (${b.tag}, line ${b.line}), run as written in ${work}:\n${b.body}`);
    let res;
    try { res = await run('bash', ['-euo', 'pipefail', '-c', b.body], { cwd: work, env, pipe: true, timeoutSec: b.tag === 'cleanroom' ? 120 : 60 }); }
    catch (e) { check(false, `README block ${i + 1} (${b.tag}) exits 0 within its time limit: ${e.message}`); continue; }
    check(true, `README block ${i + 1} (${b.tag}) exits 0 in ${res.sec.toFixed(1)} s`);
    if (b.tag === 'cleanroom') assertCleanroomOutputs(b.body, res.stdout, work, pkg.version);
    else assertMacOutputs(b.body, res.stdout, work);
  }

  // 5. MCP handshake over stdio from the install.
  await mcpHandshake(path.join(bin, 'screenrec'), work, env, readme);

  // 6. The README's build-from-source route, with the global install going to a temp prefix.
  if (process.env.CLEANROOM_SKIP_SOURCE === '1') notes.push('build-from-source route skipped (CLEANROOM_SKIP_SOURCE=1)');
  else await sourceRoute(src, pkg.version, readme);
}

// Bounds for the Quick start block: each output exists next to its input with a plausible duration.
function assertCleanroomOutputs(body, stdout, work, version) {
  if (/^screenrec version$/m.test(body)) check(stdout.includes(`screenrec ${version}`), `screenrec version prints ${version}`);
  if (!/demo\.mp4/.test(body)) return;
  const f = (n) => path.join(work, n);
  const dur = (n) => ffprobeDuration(f(n));
  check(between(dur('demo.mp4'), 5.5, 6.5), `demo.mp4 lasts about 6 s (${dur('demo.mp4')})`);
  if (/squeeze demo\.mp4 --json/.test(body)) {
    const sq = resultFor(stdout, 'demo.squeeze.mp4');
    check(sq?.ok === true && between(sq.beforeSec, 5.5, 6.5) && between(sq.afterSec, 4.0, 5.0), `squeeze --json reports about 6.0 s to 4.5 s (${sq?.beforeSec} to ${sq?.afterSec})`);
  }
  check(between(dur('demo.squeeze.mp4'), 4.0, 5.0), `demo.squeeze.mp4 lasts about 4.5 s (${dur('demo.squeeze.mp4')})`);
  for (const n of ['demo.squeeze.crop.mp4', 'demo.squeeze.blur.mp4']) check(between(dur(n), 4.0, 5.0), `${n} exists and lasts about 4.5 s (${dur(n)})`);
  const gif = f('demo.squeeze.gif.gif');
  check(fs.existsSync(gif) && fs.readFileSync(gif).subarray(0, 3).toString() === 'GIF', 'demo.squeeze.gif.gif exists and is a GIF');
  const png = f('demo.squeeze.frame-1s.png');
  check(fs.existsSync(png) && fs.readFileSync(png).subarray(1, 4).toString() === 'PNG', 'demo.squeeze.frame-1s.png exists and is a PNG');
}

function assertMacOutputs(body, stdout, work) {
  const shot = body.match(/--out (\S+\.png)/)?.[1];
  if (shot) check(fs.existsSync(path.join(work, shot)) && fs.statSync(path.join(work, shot)).size > 0, `${shot} exists`);
  if (/stop --json/.test(body)) {
    const j = lastJson(stdout);
    const out = j?.out && path.resolve(work, j.out);
    check(j?.ok === true && out && fs.existsSync(out), `stop --json reports a saved file (${j?.out})`);
    if (out && fs.existsSync(out)) check(between(ffprobeDuration(out), 1, 6), `the recording lasts 1 to 6 s (${ffprobeDuration(out)})`);
  }
}

// initialize + notifications/initialized + tools/list over newline-delimited JSON-RPC on stdio.
// Spawn errors, EPIPE and an early exit become failures, never a crash before the summary.
async function mcpHandshake(screenrec, cwd, env, readme) {
  log('screenrec mcp: initialize + tools/list over stdio');
  const child = spawn(screenrec, ['mcp'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
  if (child.pid) children.add(child.pid);
  const pending = new Map();
  let buf = '';
  let broken = '';
  const failAll = (why) => { broken ||= why; for (const [, p] of pending) p.reject(new Error(why)); pending.clear(); };
  child.on('error', (e) => failAll(`could not run screenrec mcp: ${e.message}`));
  child.stdin.on('error', (e) => failAll(`writing to screenrec mcp failed: ${e.code || e.message}`));
  const exited = new Promise((r) => child.on('exit', (code, sig) => { failAll(`screenrec mcp exited (${code ?? sig})`); r(code ?? sig); }));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { check(false, `MCP stdout carries only JSON-RPC (got: ${line.slice(0, 80)})`); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  const send = (msg) => { if (!broken && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
  const request = (id, method, params) => new Promise((resolve, reject) => {
    if (broken) return reject(new Error(broken));
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no reply in 20 s`)); }, 20000);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
    send({ id, method, params });
  });
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cleanroom', version: '0.0.0' } });
    check(!init.error && typeof init.result?.protocolVersion === 'string' && init.result?.capabilities?.tools !== undefined, `initialize answers with tools capability (server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version})`);
    send({ method: 'notifications/initialized' });
    const list = await request(2, 'tools/list', {});
    const tools = (list.result?.tools || []).map((t) => t.name);
    // The README names every tool in one sentence; the server must offer exactly those, no more, no fewer.
    const documented = documentedTools(readme);
    const missing = documented.filter((n) => !tools.includes(n));
    const extra = tools.filter((n) => !documented.includes(n));
    check(documented.length > 0 && missing.length === 0 && extra.length === 0,
      `tools/list returns the ${documented.length} tools the README lists (server ${tools.length}${missing.length ? `, missing ${missing.join(', ')}` : ''}${extra.length ? `, not in README ${extra.join(', ')}` : ''})`);
  } catch (e) { check(false, `MCP handshake: ${e.message}`); }
  if (child.stdin.writable) child.stdin.end();
  const code = child.exitCode ?? child.signalCode ?? await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  if (code === 'timeout' && child.pid) killGroup(child.pid);
  if (child.pid) children.delete(child.pid);
  check(code === 0, `screenrec mcp exits 0 when stdin closes (${code})`);
}

// "Now: build from source" as the README writes it; the GitHub URL becomes the clean clone above.
async function sourceRoute(src, version, readme) {
  const block = [...readme.matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1]).find((b) => b.includes(`git clone ${REPO_URL}.git`) && /npm install -g \./.test(b));
  if (!check(Boolean(block), 'README has the build-from-source block')) return;
  const script = block.replace(`${REPO_URL}.git`, `'${src}'`);
  const parent = dir('from-source');
  log(`README build-from-source block in ${parent}, npm global prefix ${globalPrefix}:\n${script}`);
  try {
    const r = await run('bash', ['-euo', 'pipefail', '-c', script], { cwd: parent, timeoutSec: 1800 });
    check(true, `build-from-source block exits 0 in ${r.sec.toFixed(0)} s`);
  } catch (e) { check(false, `build-from-source block exits 0: ${e.message}`); return; }
  const gbin = path.join(globalPrefix, 'bin');
  check(fs.existsSync(path.join(gbin, 'screenrec')), 'npm install -g . linked screenrec into the temp prefix');
  try {
    const v = await run('screenrec', ['version'], { cwd: parent, env: cleanEnv(gbin), pipe: true, timeoutSec: 60 });
    check(v.stdout.includes(`screenrec ${version}`), 'the source-built screenrec prints its version');
    const d = lastJson((await run('screenrec', ['doctor', '--json'], { cwd: parent, env: cleanEnv(gbin), pipe: true, timeoutSec: 120 })).stdout);
    const helper = d?.checks?.find((c) => c.name === 'capture helper');
    check(helper?.ok === true, `doctor finds the source-built capture helper (${helper?.detail})`);
  } catch (e) { check(false, `the source-built screenrec runs: ${e.message}`); }
  const archs = lipoArchs(path.join(parent, 'agent-screen-record', 'bin', 'screenrec-mac'));
  check(archs.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'), `build:native built a helper for this Mac (${archs.join(' ')})`);
}

let crashed;
try { await main(); } catch (e) { crashed = e; failures.push(`aborted: ${e.message}`); }
for (const pid of children) killGroup(pid);
if (realPrefix) check(prefixSnapshot() === prefixBefore, `the real global prefix (${realPrefix}) is unchanged: agent-screen-record and bin/screenrec have the same link target, inode and mtime`);
for (const n of notes) console.log(`\nNOTE: ${n}`);
if (failures.length) {
  console.error(`\nclean room FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  if (crashed && !/README blocks|no tarball|unreadable tarball/.test(crashed.message)) console.error(crashed.stack);
  if (!keep) console.error(`rerun with CLEANROOM_KEEP=1 to keep ${base} for inspection`);
  cleanup();
  process.exit(1);
}
cleanup();
console.log('\nclean room passed');
