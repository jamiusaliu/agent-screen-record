// Spec section 7: no network access except the loopback CDP endpoint and the loopback Chrome broker.
// These are source scans of src/: they fail the build when a network API shows up in a file that is
// not on its allow-list. Widening an allow-list needs the coordinator's approval and a spec note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : /\.(ts|mts|cts|js|mjs)$/.test(d.name) ? [path.join(dir, d.name)] : []);
const rel = (f: string) => path.relative(root, f);
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const RULES: { name: string; re: RegExp; allowed: Record<string, string> }[] = [
  { name: 'fetch', re: /\bfetch\s*\(/, allowed: {
    'capture/cdp/endpoint.ts': 'GET /json/version of a loopback CDP endpoint, after assertLoopback, redirects refused',
  } },
  { name: 'WebSocket client', re: /new\s+(WebSocket|Impl)\s*\(/, allowed: {
    'capture/cdp/client.ts': 'CdpClient connects to the loopback CDP endpoint or broker, after assertLoopback',
    'capture/cdp/broker.ts': "the broker's one upstream connection to the user's Chrome, after assertLoopback",
  } },
  { name: 'node network modules', re: /(from\s+|import\s*\(\s*|require\s*\(\s*)['"](node:)?(http|https|http2|net|tls|dgram|dns)(\/[a-z]+)?['"]/, allowed: {
    'capture/cdp/ws-server.ts': "node:http upgrade server for the Chrome broker; binds the literal '127.0.0.1' (tested below)",
  } },
  { name: 'other network clients', re: /\b(XMLHttpRequest|EventSource|sendBeacon|WebTransport|RTCPeerConnection)\b|['"]undici['"]/, allowed: {} },
  { name: 'non-loopback URL literal', re: /['"`](?:https?|wss?|ftp|tcp|udp|rtmp|rtsp):\/\/(?!127\.0\.0\.1[:/'"`]|localhost[:/'"`]|\[::1\]|['"`])/, allowed: {} },  // a bare 'ws://' prefix check names no host
];

test('no network access outside the allow-listed loopback CDP and broker files', () => {
  const problems: string[] = [];
  for (const f of files(root)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const r of RULES) if (r.re.test(src) && !(rel(f) in r.allowed)) problems.push(`${rel(f)}: ${r.name}`);
  }
  assert.deepEqual(problems, []);
});

test('every allow-listed file still exists and still needs its entry', () => {
  for (const r of RULES) {
    for (const [f, reason] of Object.entries(r.allowed)) {
      assert.ok(reason.length > 10, `${r.name}: ${f} needs a reason`);
      assert.match(read(f), r.re, `${r.name}: ${f} no longer needs its allow-list entry; remove it`);
    }
  }
});

test('every fetch and WebSocket is preceded by a loopback assertion', () => {
  assert.match(read('capture/cdp/endpoint.ts'), /assertLoopback\(url\);\s*\n\s*const r = await fetch\(url, \{ redirect: 'error' \}\)/);
  assert.match(read('capture/cdp/client.ts'), /assertLoopback\(wsUrl\);[\s\S]{0,120}new Impl\(wsUrl\)/);
  assert.match(read('capture/cdp/broker.ts'), /function connectUpstream\(url: string[^)]*\)[^{]*\{\s*assertLoopback\(url\);[\s\S]{0,120}new WebSocket\(url\)/);
  // a discovered webSocketDebuggerUrl is checked too: /json/version could name another host
  assert.match(read('capture/cdp/endpoint.ts'), /const ws = String\(j\.webSocketDebuggerUrl \?\? ''\);\s*\n\s*assertLoopback\(ws\);/);
});

test("every listen() in src binds the literal '127.0.0.1'", () => {
  let listens = 0;
  for (const f of files(root)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.listen\s*\(/g)) {
      listens++;
      // the second argument must be the literal, not a variable, a default or nothing
      const call = src.slice(m.index!, m.index! + 200);
      assert.match(call, /^\.listen\s*\(\s*[^,()]*(\([^()]*\))?[^,()]*,\s*'127\.0\.0\.1'\s*[,)]/, `${rel(f)}: ${call.split('\n')[0]}`);
    }
    assert.doesNotMatch(src, /['"](0\.0\.0\.0|::|::0)['"]/, `${rel(f)} names a wildcard address`);
  }
  assert.ok(listens >= 1, 'the broker server listens somewhere');
});

test('the broker guards its server: constant-time token, Host allow-list, Origin check, 0600 info file', () => {
  const b = read('capture/cdp/broker.ts');
  // the token compare is constant time (equal-length digests through timingSafeEqual)
  assert.match(b, /function tokenMatches\([^)]*\): boolean \{[\s\S]{0,300}crypto\.timingSafeEqual\(/);
  assert.match(b, /!tokenMatches\(req\.url, token\)/);
  assert.doesNotMatch(b, /(req\.url|reqPath)\s*[!=]==?|[!=]==?\s*`\/\$\{token\}`/, 'no plain string compare of the path');
  assert.match(b, /token = crypto\.randomBytes\(32\)/, '256-bit random token');
  // Host allow-list (DNS rebinding) and Origin check (web pages) both run before the upgrade
  assert.match(b, /const HOST_RE = \/\^\(127\\\.0\\\.0\\\.1\|localhost\)\(:\\d\{1,5\}\)\?\$\/;/);
  assert.match(b, /verify: \(req\) => \{[\s\S]{0,200}HOST_RE\.test\(req\.headers\.host \?\? ''\)[\s\S]{0,300}req\.headers\.origin/);
  // the info file holds the token: written 0600 (and chmod in case the temp file existed) into a 0700 dir
  assert.match(b, /writeFileSync\(tmp, JSON\.stringify\(info\), \{ mode: 0o600 \}\);\s*\n\s*fs\.chmodSync\(tmp, 0o600\);/);
});
