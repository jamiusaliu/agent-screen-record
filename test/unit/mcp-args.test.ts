import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path';
import { toArgs, expandHome } from '../../src/mcp/server.ts';

test('toArgs maps snake_case MCP inputs to the CLI kebab-case flags', () => {
  const a = toArgs('start', [], { window: 'Docs:Q3: plan', follow_app: true, ignore_app: ['A', 'B'], no_meta: true, fps: 15, display_of: 'Finder', out: undefined });
  assert.deepEqual(a, {
    command: 'start', positionals: [], json: true,
    values: { window: 'Docs:Q3: plan', 'follow-app': true, 'ignore-app': ['A', 'B'], 'no-meta': true, fps: '15', 'display-of': 'Finder' },
  });
  assert.deepEqual(toArgs('crop', ['in.mp4'], { trim_edges: 8 }).values, { 'trim-edges': '8' });
  assert.deepEqual(toArgs('trim', ['x'], { from: 0, to: 1.5 }).values, { from: '0', to: '1.5' }, 'zero is kept');
  assert.deepEqual(toArgs('squeeze', ['x'], { hold: 0 }).values, { hold: '0' }, 'hold 0 is passed, not dropped');
});

test('expandHome expands a leading ~ or ~/ only', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/My Videos/é.mp4'), path.join(os.homedir(), 'My Videos/é.mp4'));
  assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
  assert.equal(expandHome('~other/x'), '~other/x');
  assert.equal(expandHome('rel/x'), 'rel/x');
});
