// The real-machine matrix (test/mac-matrix) needs the screen; its pure parts are checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain .mjs without type declarations
import { parseFlags, summarise } from '../mac-matrix/flags.mjs';
// @ts-expect-error plain .mjs without type declarations
import { parseBounds, contains, coveredFinderVerdict } from '../mac-matrix/verdict.mjs';

test('parseFlags reads the three flags', () => {
  assert.deepEqual(parseFlags([]), { autoOnly: false, noAppend: false, only: undefined });
  assert.deepEqual(parseFlags(['--auto-only']), { autoOnly: true, noAppend: false, only: undefined });
  assert.deepEqual(parseFlags(['--only', 'window moved', '--no-append']), { autoOnly: false, noAppend: true, only: 'window moved' });
});

test('parseFlags refuses a missing, flag-like or blank --only value, a repeat and unknown flags', () => {
  for (const argv of [['--only'], ['--only', '--no-append'], ['--only', ' '], ['--only', 'a', '--only', 'b'], ['--onyl', 'x'], ['window']]) {
    assert.throws(() => parseFlags(argv), Error, JSON.stringify(argv));
  }
});

test('summarise exits 1 only on FAIL or MANUAL-FAIL and names open rows', () => {
  assert.equal(summarise([{ result: 'PASS' }, { result: 'FAIL' }]).code, 1);
  assert.equal(summarise([{ result: 'MANUAL-FAIL' }]).code, 1);
  const open = summarise([{ result: 'PASS' }, { result: 'PENDING' }, { result: 'INCONCLUSIVE' }]);
  assert.equal(open.code, 0);
  assert.match(open.line, /2 row\(s\) are PENDING or INCONCLUSIVE/);
  assert.equal(summarise([{ result: 'PASS' }]).line, 'Summary: 1 PASS. Exit 0.');
  assert.match(summarise([]).line, /no scenarios ran/);
});

test('parseBounds and contains', () => {
  assert.deepEqual(parseBounds('0, 30, 1440, 900'), [0, 30, 1440, 900]);
  assert.throws(() => parseBounds('0, 30, 1440'));
  assert.equal(contains([0, 30, 1440, 900], [200, 150, 800, 650]), true);
  assert.equal(contains([0, 30, 1440, 600], [200, 150, 800, 650]), false);
  assert.equal(contains([-1920, 0, 0, 1080], [200, 150, 800, 650]), false);
});

test('coveredFinderVerdict needs a cover, a quiet baseline and a clear change', () => {
  assert.equal(coveredFinderVerdict({ baseline: 0.1, change: 8, covered: true }).result, 'PASS');
  assert.equal(coveredFinderVerdict({ baseline: 0.1, change: 8, covered: false }).result, 'INCONCLUSIVE');
  assert.equal(coveredFinderVerdict({ baseline: 2, change: 8, covered: true }).result, 'INCONCLUSIVE');
  assert.equal(coveredFinderVerdict({ baseline: 0.1, change: 2, covered: true }).result, 'FAIL');
  assert.equal(coveredFinderVerdict({ baseline: 0.9, change: 2.5, covered: true }).result, 'FAIL');
});
