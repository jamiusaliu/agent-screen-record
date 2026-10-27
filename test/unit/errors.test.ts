import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenrecError, errorJson } from '../../src/core/errors.ts';

test('ScreenrecError carries code, message, fix and candidates', () => {
  const e = new ScreenrecError('E_TARGET_AMBIGUOUS', '2 windows match "Finder"', 'Add a title: --window "Finder:Downloads"', ['Finder: Downloads', 'Finder: Desktop']);
  assert.equal(e.code, 'E_TARGET_AMBIGUOUS');
  assert.ok(e instanceof Error);
  assert.deepEqual(errorJson(e), {
    ok: false, code: 'E_TARGET_AMBIGUOUS', message: '2 windows match "Finder"',
    fix: 'Add a title: --window "Finder:Downloads"', candidates: ['Finder: Downloads', 'Finder: Desktop'],
  });
});

test('unknown errors map to E_HELPER_CRASHED with a debug fix', () => {
  const j = errorJson(new Error('boom'));
  assert.equal(j.code, 'E_HELPER_CRASHED');
  assert.equal(j.message, 'internal error: boom');
  assert.match(j.fix, /SCREENREC_DEBUG=1/);
  assert.equal('candidates' in j, false);
});

test('an unexpected exception keeps E_HELPER_CRASHED but says it is an internal error', () => {
  const j = errorJson(new TypeError("Cannot read properties of undefined (reading 'filter')"));
  assert.equal(j.code, 'E_HELPER_CRASHED');
  assert.match(j.message, /^internal error: Cannot read properties/);
  assert.match(j.fix, /bug/i);
});
