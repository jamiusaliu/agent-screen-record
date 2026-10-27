// The screen-state pieces that need no real lock: the helper's screen events turned into stop
// warnings, the status note, and the explanation of a helper timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenGaps, screenGapWarnings, spokenDuration, screenStatusNote } from '../../src/recorder.ts';
import { helperTimeoutError, recorderTimeoutError, screenNote } from '../../src/capture/mac.ts';

const c = (t: number, state: string) => ({ t, state });

test('a lock and unlock in the middle is one gap on the video clock', () => {
  assert.deepEqual(screenGaps([c(45, 'locked'), c(157, 'awake')], 200), [{ state: 'locked', from: 45, to: 157 }]);
});

test('a lock still open at stop runs to the end of the video', () => {
  assert.deepEqual(screenGaps([c(10, 'locked')], 30), [{ state: 'locked', from: 10, to: 30 }]);
});

test('sleep then lock is one gap named by the stronger state; each of the three states has its own text', () => {
  assert.deepEqual(screenGaps([c(5, 'asleep'), c(6, 'locked'), c(9, 'awake')], 20), [{ state: 'locked', from: 5, to: 9 }]);
  assert.deepEqual(screenGaps([c(1, 'asleep'), c(3, 'awake'), c(4, 'off-console'), c(6, 'awake')], 9),
    [{ state: 'asleep', from: 1, to: 3 }, { state: 'off-console', from: 4, to: 6 }]);
});

test('a lock that was on when the recording started is no warning when the video begins at the unlock', () => {
  // locked before the first frame (negative on the video clock); the unlock is seen up to 1 s late
  assert.deepEqual(screenGaps([c(-12, 'locked'), c(0.9, 'awake')], 30), []);
  assert.deepEqual(screenGapWarnings([c(-12, 'locked'), c(0.9, 'awake')], 30), []);
  // but a lock that really held up the start of the video still counts, from 0
  assert.deepEqual(screenGaps([c(-12, 'locked'), c(8, 'awake')], 30), [{ state: 'locked', from: 0, to: 8 }]);
});

test('a one-second lock in the middle is reported; under a second, or starting within a second of stop, is not', () => {
  // the 1 s poll: a real lock of 1 to 2 s measures one or two ticks
  assert.deepEqual(screenGaps([c(10, 'locked'), c(11, 'awake')], 30), [{ state: 'locked', from: 10, to: 11 }]);
  assert.deepEqual(screenGaps([c(10, 'locked'), c(10.6, 'awake')], 30), []);
  assert.deepEqual(screenGaps([c(29.4, 'locked')], 30), []);
});

test('events out of order are sorted; awake without a lock and unknown states are ignored', () => {
  assert.deepEqual(screenGaps([c(9, 'awake'), c(2, 'awake'), c(4, 'locked'), c(5, 'garbage')], 10), [{ state: 'locked', from: 4, to: 9 }]);
  assert.deepEqual(screenGaps([], 10), []);
});

test('the stop warning says how long, where in the video, and that it is frozen or blank', () => {
  assert.deepEqual(screenGapWarnings([c(45, 'locked'), c(157, 'awake')], 200),
    ['the screen was locked for 1m 52s (0:45 to 2:37 in the video); that part of the video is frozen or blank']);
  assert.match(screenGapWarnings([c(1, 'asleep')], 3.4)[0], /^the displays were asleep for 2s \(0:01 to 0:03 in the video\)/);
  assert.match(screenGapWarnings([c(0, 'off-console')], 4000)[0], /^another user session had the screen for 1h 6m 40s \(0:00 to 1:06:40/);
  assert.deepEqual(screenGapWarnings([], 10), []);
});

test('spokenDuration', () => {
  assert.equal(spokenDuration(0.4), '0s'); assert.equal(spokenDuration(59.6), '1m 0s'); assert.equal(spokenDuration(112), '1m 52s'); assert.equal(spokenDuration(3605), '1h 0m 5s');
});

test('status note only for a screen that draws nothing', () => {
  assert.match(screenStatusNote('locked')!, /^the screen is locked: nothing is being captured until it is unlocked/);
  assert.match(screenStatusNote('asleep')!, /displays are asleep/);
  assert.match(screenStatusNote('off-console')!, /another user session/);
  for (const v of ['awake', undefined, null, 'garbage', 3]) assert.equal(screenStatusNote(v), null);
});

test('a helper timeout names a locked or sleeping screen instead of guessing at a permission dialog', () => {
  const locked = helperTimeoutError(30, 'locked');
  assert.equal(locked.code, 'E_TARGET_NOT_FOUND');
  assert.match(locked.message, /did not answer within 30 s: the screen is locked/);
  assert.doesNotMatch(locked.message, /permission/);
  assert.match(locked.fix, /^Unlock the Mac and try again\. .*caffeinate -d/);
  assert.match(helperTimeoutError(30, 'asleep').fix, /^Wake the displays/);
  assert.match(helperTimeoutError(30, 'off-console').message, /another user session/);
  for (const v of ['awake', null, undefined]) {
    const e = helperTimeoutError(5, v);
    assert.equal(e.code, 'E_HELPER_CRASHED'); assert.match(e.message, /within 5 s \(a macOS permission dialog may be waiting\)/);
  }
  assert.equal(screenNote('awake'), null);
});

test('a stuck recorder is named as such, not blamed on a permission dialog', () => {
  const e = recorderTimeoutError(30, 'awake');
  assert.equal(e.code, 'E_HELPER_CRASHED'); assert.match(e.message, /^the running recorder did not answer within 30 s$/); assert.match(e.fix, /screenrec stop/);
  assert.doesNotMatch(e.message + e.fix, /permission/);
  const l = recorderTimeoutError(30, 'locked');
  assert.equal(l.code, 'E_TARGET_NOT_FOUND'); assert.match(l.message, /the screen is locked/); assert.match(l.fix, /^Unlock the Mac/);
});
