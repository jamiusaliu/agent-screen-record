import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue, FrameHolder, outputSize, encoderArgs } from '../../src/capture/cdp/pacer.ts';

test('framesDue catches up a gap with held frames and never goes negative', () => {
  assert.equal(framesDue(0, 1000, 30, 0), 30);   // first frame arrived 1 s after start: hold it for 30 frames
  assert.equal(framesDue(0, 1000, 30, 30), 0);
  assert.equal(framesDue(0, 1033, 30, 30), 0);
  assert.equal(framesDue(0, 1034, 30, 30), 1);
  assert.equal(framesDue(0, 500, 30, 40), 0);
});

test('FrameHolder keeps the latest frame and counts arrivals', () => {
  const h = new FrameHolder();
  assert.equal(h.get(), null); assert.equal(h.received, 0);
  h.set(Buffer.from('a')); h.set(Buffer.from('b'));
  assert.equal(h.get()!.toString(), 'b'); assert.equal(h.received, 2);
});

test('outputSize is even device pixels', () => {
  assert.deepEqual(outputSize(1280, 721, 2), { width: 2560, height: 1442 });
  assert.deepEqual(outputSize(801, 501, 1), { width: 800, height: 500 });
});

test('encoderArgs pads every tab to one fixed size', () => {
  const a = encoderArgs('/tmp/x y.mkv', 30, { width: 800, height: 500 });
  assert.deepEqual(a.slice(0, 9), ['-hide_banner', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30']);
  assert.ok(a.includes('scale=800:500:force_original_aspect_ratio=decrease,pad=800:500:(ow-iw)/2:(oh-ih)/2,format=yuv420p'));
  assert.equal(a.at(-1), '/tmp/x y.mkv');
});
