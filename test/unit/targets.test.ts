import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, parseWindowSelector, matchWindow, frontWindowOfApp, type WindowInfo } from '../../src/core/targets.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const w = (id: number, app: string, title: string, z: number, onScreen = true): WindowInfo =>
  ({ id, app, title, x: 0, y: 0, width: 800, height: 500, onScreen, z, pid: 100 + id });
const windows = [
  w(10, 'Finder', 'Downloads', 1), w(11, 'Finder', 'Desktop', 3),
  w(20, 'Google Chrome', 'Docs: Q3: plan', 0), w(30, 'Préview', 'été.png', 2),
];

test('window selector splits app and title on the first colon only', () => {
  assert.deepEqual(parseWindowSelector('Google Chrome:Docs: Q3: plan'), { app: 'Google Chrome', title: 'Docs: Q3: plan' });
  assert.deepEqual(parseWindowSelector('Finder'), { app: 'Finder' });
  assert.deepEqual(parseWindowSelector('3654'), { id: 3654 });
});

test('matchWindow by app and title, case-insensitive, unicode-safe', () => {
  assert.equal(matchWindow(windows, { app: 'finder', title: 'down' }).id, 10);
  assert.equal(matchWindow(windows, { app: 'préview' }).id, 30);
  assert.equal(matchWindow(windows, { app: 'Google Chrome', title: 'Docs: Q3: plan' }).id, 20);
  assert.equal(matchWindow(windows, { id: 11 }).id, 11);
});

test('ambiguous match lists candidates instead of guessing', () => {
  assert.throws(() => matchWindow(windows, { app: 'Finder' }), (e: ScreenrecError) =>
    e.code === 'E_TARGET_AMBIGUOUS' && e.candidates!.length === 2 && e.candidates![0].includes('Downloads'));
});

test('no match is E_TARGET_NOT_FOUND', () => {
  assert.throws(() => matchWindow(windows, { app: 'Safari' }), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND');
});

test('frontWindowOfApp takes the lowest z among on-screen windows', () => {
  assert.equal(frontWindowOfApp(windows, 'Finder').id, 10);
});

test('parseTarget for each kind and rejects zero or two targets', () => {
  assert.deepEqual(parseTarget({ window: 'Finder:Downloads' }), { kind: 'window', app: 'Finder', title: 'Downloads', followApp: false, ignoreApps: [] });
  assert.deepEqual(parseTarget({ app: 'Safari', 'follow-app': true, 'ignore-app': ['Orca'] }), { kind: 'app', app: 'Safari', followApp: true, ignoreApps: ['Orca'] });
  assert.deepEqual(parseTarget({ display: 'main' }), { kind: 'display', display: 'main' });
  assert.deepEqual(parseTarget({ 'display-of': 'Finder' }), { kind: 'display-of', window: 'Finder' });
  assert.deepEqual(parseTarget({ region: '10,20,300,200', display: '2' }), { kind: 'region', region: { x: 10, y: 20, width: 300, height: 200 }, display: '2' });
  assert.deepEqual(parseTarget({ tab: 'url:github.com', cdp: 'http://127.0.0.1:9222' }), { kind: 'tab', mode: 'url', pattern: 'github.com', cdp: 'http://127.0.0.1:9222' });
  assert.deepEqual(parseTarget({ tab: 'follow' }), { kind: 'tab', mode: 'follow' });
  assert.throws(() => parseTarget({}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ window: 'A', tab: 'newest' }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ region: '1,2,3' , display: 'main'}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ tab: 'sideways' }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('empty app or title in a window selector is E_BAD_ARGS', () => {
  for (const s of ['App:', ':x', '', '  ']) assert.throws(() => parseWindowSelector(s), (e: ScreenrecError) => e.code === 'E_BAD_ARGS', s);
});

test('malformed regions are E_BAD_ARGS', () => {
  for (const r of [',,,', '1,2,,4', '1,2,0,5', '1,2,5,-3', '1,2,3,4,5', '']) {
    assert.throws(() => parseTarget({ region: r, display: 'main' }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS', r);
  }
});

test('flags that do not apply to the chosen target are E_BAD_ARGS naming the flag, never silently dropped', () => {
  const bad = (o: Parameters<typeof parseTarget>[0], flag: string) => assert.throws(() => parseTarget(o),
    (e: ScreenrecError) => e.code === 'E_BAD_ARGS' && e.message.includes(flag), flag);
  bad({ display: 'main', 'follow-app': true }, '--follow-app');
  bad({ tab: 'newest', 'follow-app': true }, '--follow-app');
  bad({ window: 'Finder', cdp: 'http://127.0.0.1:9222' }, '--cdp');
  bad({ app: 'Finder', 'ignore-app': ['Terminal'] }, '--ignore-app');
  bad({ display: 'main', 'ignore-app': ['Terminal'], 'follow-app': true }, '--follow-app');
  assert.equal(parseTarget({ app: 'Finder', 'follow-app': true, 'ignore-app': ['Terminal'] }).kind, 'app');
  assert.equal(parseTarget({ tab: 'newest', cdp: 'http://127.0.0.1:9222' }).kind, 'tab');
  assert.equal(parseTarget({ window: 'Finder', 'follow-app': false, 'ignore-app': [] }).kind, 'window');
});
