import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveTabs } from '../../src/capture/chrome-applescript.ts';

test('parseActiveTabs reads index, title and url per line, titles may contain colons', () => {
  const out = '1\tInbox (3): Mail\thttps://mail.test/\n2\tAgent Docs\thttps://docs.test/a\n';
  assert.deepEqual(parseActiveTabs(out), [
    { windowIndex: 1, title: 'Inbox (3): Mail', url: 'https://mail.test/' },
    { windowIndex: 2, title: 'Agent Docs', url: 'https://docs.test/a' },
  ]);
  assert.deepEqual(parseActiveTabs(''), []);
});
