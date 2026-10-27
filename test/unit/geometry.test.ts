import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { even, resolveDisplay, displayOfRect, regionToPixels, pixelSize, type Display } from '../../src/core/geometry.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const displays: Display[] = JSON.parse(fs.readFileSync(new URL('../fixtures/two-displays.json', import.meta.url), 'utf8'));

test('even rounds down and never goes below 2', () => {
  assert.equal(even(801), 800); assert.equal(even(500), 500); assert.equal(even(1), 2); assert.equal(even(333.7), 332);
});

test('resolveDisplay by main, index and name', () => {
  assert.equal(resolveDisplay(displays, 'main').id, 1);
  assert.equal(resolveDisplay(displays, '2').id, 2);
  assert.equal(resolveDisplay(displays, 'lg').id, 2);
  assert.throws(() => resolveDisplay(displays, '3'), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && e.candidates!.length === 2);
});

test('displayOfRect picks the display holding most of the window, including negative x', () => {
  assert.equal(displayOfRect(displays, { x: -1500, y: 100, width: 800, height: 500 }).id, 2);
  assert.equal(displayOfRect(displays, { x: -100, y: 100, width: 800, height: 500 }).id, 1);
});

test('regionToPixels uses that display scale and stays even', () => {
  assert.deepEqual(regionToPixels(displays[0], { x: 10, y: 20, width: 400.5, height: 301 }), { x: 20, y: 40, width: 800, height: 602 });
  assert.deepEqual(regionToPixels(displays[1], { x: 0, y: 0, width: 801, height: 501 }), { x: 0, y: 0, width: 800, height: 500 });
});

test('regionToPixels rejects a region that leaves its display', () => {
  assert.throws(() => regionToPixels(displays[0], { x: 1400, y: 0, width: 100, height: 100 }), (e: ScreenrecError) => e.code === 'E_REGION_SPANS_DISPLAYS');
  assert.throws(() => regionToPixels(displays[0], { x: -1, y: 0, width: 10, height: 10 }), (e: ScreenrecError) => e.code === 'E_REGION_SPANS_DISPLAYS');
});

test('pixelSize for a 1x and a 2x window', () => {
  assert.deepEqual(pixelSize(801, 501, 1), { width: 800, height: 500 });
  assert.deepEqual(pixelSize(800, 500, 2), { width: 1600, height: 1000 });
});

test('resolveDisplay rejects empty or blank selectors with the display list', () => {
  for (const s of ['', '   ']) {
    assert.throws(() => resolveDisplay(displays, s), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && e.candidates!.length === 2, JSON.stringify(s));
  }
});
