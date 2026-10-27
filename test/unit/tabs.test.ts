import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabTracker } from '../../src/capture/cdp/tabs.ts';

const t = (id: string, url = `https://x.test/${id}`, title = id) => ({ targetId: id, url, title });

test('newest ignores tabs that existed before start and falls back when the newest closes', () => {
  const k = new TabTracker('newest', undefined, [t('old')]);
  assert.equal(k.current(), null);
  k.created(t('a')); assert.equal(k.current(), 'a');
  k.created(t('b')); assert.equal(k.current(), 'b');
  k.destroyed('b'); assert.equal(k.current(), 'a');
  k.destroyed('a'); assert.equal(k.current(), null);
});

test('follow switches on creation and on activation of agent tabs only', () => {
  const k = new TabTracker('follow', undefined, [t('user')]);
  k.created(t('a')); k.created(t('b')); assert.equal(k.current(), 'b');
  k.activated('a'); assert.equal(k.current(), 'a');
  k.activated('user'); assert.equal(k.current(), 'a', "the user's own tab never takes over");
  k.destroyed('a'); assert.equal(k.current(), 'b');
  assert.deepEqual(k.agentTabs(), ['b']);
});

test('url and title modes match existing tabs, stick, and re-match after close', () => {
  const k = new TabTracker('url', 'GitHub.com', [t('x', 'https://example.com'), t('g', 'https://github.com/a')]);
  assert.equal(k.current(), 'g');
  k.created(t('g2', 'https://github.com/b')); assert.equal(k.current(), 'g', 'sticky');
  k.destroyed('g'); assert.equal(k.current(), 'g2');
  const tt = new TabTracker('title', 'inbox', [t('m', 'https://mail.test', 'Inbox (3)')]);
  assert.equal(tt.current(), 'm');
  tt.changed({ targetId: 'm', url: 'https://mail.test', title: 'Sent' }); assert.equal(tt.current(), 'm', 'sticky after title change');
});

test('label is human readable', () => {
  const k = new TabTracker('newest', undefined, []);
  k.created(t('a', 'https://x.test/a', 'Docs: Q3'));
  assert.equal(k.label('a'), 'Docs: Q3 (https://x.test/a)');
});

test('created for an already-known targetId is treated as changed (discovery replay)', () => {
  const k = new TabTracker('newest', undefined, [t('user')]);
  k.created(t('user', 'https://x.test/user2', 'renamed'));
  assert.equal(k.current(), null);
  assert.deepEqual(k.agentTabs(), []);
  assert.equal(k.label('user'), 'renamed (https://x.test/user2)');
  k.created(t('a')); k.created(t('a')); assert.deepEqual(k.agentTabs(), ['a']);
});

test('url and title modes require a non-empty pattern', () => {
  for (const mode of ['url', 'title'] as const)
    for (const p of [undefined, '', '  '])
      assert.throws(() => new TabTracker(mode, p, []), (e: any) => e.code === 'E_BAD_ARGS');
});

test('an empty url or title pattern names the real flag form (--tab url:<text>)', () => {
  for (const mode of ['url', 'title'] as const) {
    assert.throws(() => new TabTracker(mode, ' ', []), (e: Error & { code?: string; fix?: string }) => {
      assert.equal(e.code, 'E_BAD_ARGS');
      assert.match(e.fix!, new RegExp(`--tab ${mode}:github\\.com`));
      assert.doesNotMatch(`${e.message} ${e.fix}`, /--tab-/);
      return true;
    });
  }
});
