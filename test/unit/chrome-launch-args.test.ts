import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeTestArgs } from '../../test/chrome/launch.ts';

// Tests must never touch the user's keychain or show any macOS dialog.
test('Chrome for Testing launches headless with a mock keychain and a basic password store', () => {
  const args = chromeTestArgs('/tmp/ud');
  for (const flag of ['--use-mock-keychain', '--password-store=basic', '--headless=new', '--user-data-dir=/tmp/ud', '--remote-debugging-port=0']) {
    assert.ok(args.includes(flag), `missing ${flag}: ${args.join(' ')}`);
  }
  assert.equal(args.some((a) => a === '--headless=false' || a.startsWith('--no-headless')), false);
});
