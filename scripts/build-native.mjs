// Builds native/macos into bin/screenrec-mac.
// Default (npm run build:native, for development): tries a universal binary (arm64 + x86_64) and falls
// back to the host architecture with a loud warning.
// --universal (used by prepack, so every packed release): no fallback; fails unless the result holds
// both arm64 and x86_64, and fails off macOS, where the helper cannot be built at all.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const universalOnly = process.argv.includes('--universal');
const WANT = ['arm64', 'x86_64'];
if (process.platform !== 'darwin') {
  if (universalOnly) { console.error('build:native --universal: the macOS helper can only be built on macOS; pack the release on a Mac.'); process.exit(1); }
  console.log('build:native skipped (not macOS)'); process.exit(0);
}
const pkg = path.resolve('native/macos'); const out = path.resolve('bin/screenrec-mac');
const build = (extra) => execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg, ...extra], { stdio: 'inherit' });
// Ask SwiftPM where it put the product: the directory name drops the triple's OS version.
const binPath = (extra) => execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg, ...extra, '--show-bin-path'], { encoding: 'utf8' }).trim();
const productFor = (triple) => path.join(binPath(['--triple', triple]), 'screenrec-mac');
try {
  const triples = WANT.map((a) => `${a}-apple-macosx13.0`);
  for (const t of triples) build(['--triple', t]);
  execFileSync('lipo', ['-create', '-output', out, ...triples.map(productFor)], { stdio: 'inherit' });
  console.log(`universal binary: ${out}`);
} catch (e) {
  if (universalOnly) { console.error(`build:native --universal failed: ${e.message.split('\n')[0]}`); process.exit(1); }
  console.warn(`\nWARNING: universal build failed (${e.message.split('\n')[0]}).\nWARNING: building for this Mac's architecture only (${process.arch}); do not release this helper.\n`);
  build([]);
  fs.copyFileSync(path.join(binPath([]), 'screenrec-mac'), out);
}
fs.chmodSync(out, 0o755);
const archs = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim().split(/\s+/);
console.log(`${out}: ${archs.join(' ')}`);
const missing = WANT.filter((a) => !archs.includes(a));
if (missing.length && universalOnly) { console.error(`build:native --universal: the helper lacks ${missing.join(', ')}`); process.exit(1); }
if (missing.length) console.warn(`WARNING: the helper lacks ${missing.join(', ')}; Macs with that architecture cannot record.`);
