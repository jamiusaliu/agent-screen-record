// A packed release must hold the compiled CLI and the macOS helper: bin/screenrec imports ../dist,
// and dist/ and bin/screenrec-mac are gitignored, so only a prepack build puts them in the tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('prepack builds the TypeScript and a universal native helper', () => {
  const prepack: string = pkg.scripts.prepack;
  assert.ok(prepack, 'package.json has a prepack script');
  assert.match(prepack, /npm run build\b/);
  assert.match(prepack, /build-native\.mjs --universal|build:native -- --universal/);
  assert.ok(prepack.indexOf('&&') > 0 && !/;|\|\|/.test(prepack), 'steps are joined with && so a failed build fails the pack');
});

test('files ships dist and the helper path', () => {
  const files: string[] = pkg.files;
  assert.ok(files.includes('dist'), 'files includes dist');
  assert.ok(files.includes('bin') || files.includes('bin/screenrec-mac'), 'files includes bin/screenrec-mac');
  assert.match(fs.readFileSync(new URL('../../bin/screenrec', import.meta.url), 'utf8'), /\.\.\/dist\/cli\/main\.js/);
});

test('the published build ships no source maps that point at the unshipped src/', () => {
  const ts = JSON.parse(fs.readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.files.includes('src'), 'src is not shipped');
  assert.notEqual(ts.compilerOptions.sourceMap, true, 'so dist must not carry .js.map files');
});
