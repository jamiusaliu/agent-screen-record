import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRect, cropRect, cropArgs } from '../../src/edit/crop.ts';
import { trimArgs } from '../../src/edit/trim.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const frame = { width: 1600, height: 1000 };

test('cropRect rounds odd sizes down to even', () => {
  assert.deepEqual(cropRect(frame, { rect: { x: 10, y: 10, width: 333, height: 201 } }), { x: 10, y: 10, width: 332, height: 200 });
});

test('trimEdges removes an equal border', () => {
  assert.deepEqual(cropRect(frame, { trimEdges: 8 }), { x: 8, y: 8, width: 1584, height: 984 });
});

test('cropRect rejects a rectangle outside the frame, or no option', () => {
  assert.throws(() => cropRect(frame, { rect: { x: 1500, y: 0, width: 200, height: 100 } }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => cropRect(frame, {}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseRect('1,2,3'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('cropArgs and trimArgs are argument arrays', () => {
  assert.ok(cropArgs('in.mp4', 'out.mp4', { x: 1, y: 2, width: 4, height: 6 }).includes('crop=4:6:1:2'));
  const t = trimArgs('in.mp4', 'out.mp4', 2, 5);
  assert.deepEqual(t.slice(0, 8), ['-v', 'error', '-y', '-ss', '2', '-to', '5', '-i']);
});
